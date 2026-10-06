// MTS CallGuard — backend для МТС Беларусь
// Реализовано по CJM.md:
//   CJM 1: ИИ-агент обработки входящих звонков (уведомления в Telegram, резюме,
//          маршрутизация голос/Telegram, экстренный перевод на человека)
//   CJM 2: ИИ-агент фиксации договорённостей (транскрибация -> задачи, сроки,
//          напоминания, KPI, экспорт CSV)
//
// Запуск: node server.js  (Node.js 18+, зависимостей из npm нет)

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const EVENTS_FILE = path.join(DATA_DIR, 'mts-events.ndjson');

// ---------------------------------------------------------------------------
// .env загрузчик (без внешних зависимостей)
// ---------------------------------------------------------------------------
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnv();

// ---------------------------------------------------------------------------
// Хранилище (JSON файл + атомарная запись)
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();

function defaultDb() {
  return { calls: [], agreements: [], settings: defaultSettings(), eventsCount: 0 };
}

function defaultSettings() {
  return {
    routingMode: 'voice',            // voice | telegram — CJM 1 этап 3 (маршрутизация)
    greeting: 'Здравствуйте! Иван Петров не может ответить, но ваш звонок важен. Чем могу помочь?',
    faq: [
      { question: 'часы работы', answer: 'Работаем с 9:00 до 18:00 по минскому времени.' },
      { question: 'адрес', answer: 'г. Минск, прит. Победителей, 110.' }
    ],
    priorityRules: { keywordsHigh: ['клиент', 'договор', 'оплата', 'срочно'], transferPhrase: 'соедините с менеджером' },
    // Триггеры — корни слов (совпадают и с «пришлите», и с «пришлю», и с «отправим»):
    agreementTriggers: [
      'пришл', 'отправ', 'обязуем', 'свяжем', 'созвон', 'встретим', 'перезвон', 'вышлем',
      'до пятницы', 'до понедельника', 'в течение', 'на следующей неделе', 'срок', 'обещаем'
    ],
    reminderBeforeHours: 24,          // напоминание за сутки до срока (CJM 2 этап 5)
    transcriptionAccuracyTarget: 0.9  // ориентир точности STT из CJM 2 (>= 90%)
  };
}

let db = defaultDb();
function loadDb() {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.agreements) db.agreements = [];
    if (!db.settings) db.settings = defaultSettings();
  } catch (e) {
    db = defaultDb();
  }
}
function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
loadDb();

// ---------------------------------------------------------------------------
// Простая нормализация телефонных номеров / идентификаторов из payload МТС
// ---------------------------------------------------------------------------
function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/[^\d+]/g, '');
  if (s.startsWith('810')) s = '+375' + s.slice(3);
  if (s.startsWith('80')) s = '+375' + s.slice(2);
  if (s.startsWith('375') && !s.startsWith('+')) s = '+' + s;
  if (s.length === 9 && !s.startsWith('+')) s = '+375' + s; // 291112233
  return s || null;
}

function pick(obj, names) {
  for (const n of names) {
    const v = obj && obj[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function normalizeEvent(payload) {
  const p = payload || {};
  const caller = normalizePhone(pick(p, ['caller', 'from', 'caller_number', 'callingNumber', 'phone', 'customer_phone']));
  const callee = normalizePhone(pick(p, ['callee', 'to', 'did', 'internal_number', 'calledNumber']));
  const callId = pick(p, ['call_id', 'callId', 'session_id', 'sessionId', 'id', 'uniqueId']) || crypto.randomUUID();
  const status = pick(p, ['status', 'event', 'event_type', 'call_status']) || 'received';
  const recordUrl = pick(p, ['record_url', 'recordUrl', 'recording_url', 'recordingUrl', 'record']);
  const transcript = pick(p, ['transcript', 'text', 'speech_text', 'asr_text']);
  const durationSec = Number(pick(p, ['duration', 'duration_sec', 'talk_time'])) || 0;
  const startedAt = pick(p, ['timestamp', 'created_at', 'start_time', 'date_start']) || nowIso();
  return { callId: String(callId), caller, callee, status, recordUrl, transcript, durationSec, startedAt: String(startedAt) };
}

// ---------------------------------------------------------------------------
// ИИ-слой (правила вместо внешнего LLM — легко заменить на реальный провайдер)
// ---------------------------------------------------------------------------
const STOPWORDS_TR = ['и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то', 'все', 'она', 'так', 'его', 'но', 'ты', 'к', 'у', 'we', 'and', 'the'];

function classifyCall(transcript) {
  const t = (transcript || '').toLowerCase();
  if (!t) return { category: 'неизвестно', priority: 'normal' };
  const has = (words) => words.some((w) => t.includes(w));
  let category = 'прочее';
  if (has(['купить', 'цена', 'стоимость', 'кп', 'прайс', 'поставк'])) category = 'продажи';
  else if (has(['ошибк', 'не работает', 'поломк', 'претензи', 'жалоб'])) category = 'поддержка';
  else if (has(['партнёр', 'сотруднич', 'переговор', 'контракт'])) category = 'партнёрство';
  else if (has(['встрет', 'позвон', 'перезвон'])) category = 'организация встречи';
  const high = db.settings.priorityRules.keywordsHigh;
  const priority = has(high) ? 'high' : (category === 'прочее' ? 'normal' : 'normal');
  return { category, priority };
}

function summarize(transcript) {
  const t = (transcript || '').trim();
  if (!t) return 'Расшифровка не получена. Звонок зарегистрирован.';
  const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  const key = extractKeywords(t).slice(0, 5);
  const lead = sentences.slice(0, 2).join(' ');
  return `Звонящий: ${lead || t.slice(0, 160)}${(lead && lead.length < t.length) ? '…' : ''} Ключевые темы: ${key.join(', ') || '—'}.`;
}

function extractKeywords(text) {
  const freq = {};
  for (const wRaw of (text || '').toLowerCase().split(/[^\p{L}\p{N}-]+/u)) {
    const w = wRaw.trim();
    if (w.length < 4 || STOPWORDS_TR.includes(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([w]) => w);
}

// Выделение договорённостей: «пришлю КП до 15.05», «ответим в течение 3 дней» (CJM 2)
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const WEEKDAYS = { 'понедельник': 1, 'вторник': 2, 'среду': 3, 'четверг': 4, 'пятниц': 5, 'суббот': 6, 'воскресень': 7 };

function parseDueDate(text, from = new Date()) {
  let m = text.match(/(?:до|к)\s+(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]) - 1;
    const y = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : from.getFullYear();
    const date = new Date(y, mo, d, 18, 0);
    if (date < from) date.setFullYear(y + 1);
    return date.toISOString();
  }
  // «до 15 октября» — текстовое название месяца
  m = text.match(/(?:до|к)\s+(\d{1,2})\s+([а-яёa-z]+)/i);
  if (m) {
    const day = Number(m[1]);
    const monthWord = m[2].toLowerCase();
    const idx = MONTHS.findIndex((mo) => monthWord.startsWith(mo.slice(0, 3)));
    if (idx >= 0) {
      const date = new Date(from.getFullYear(), idx, day, 18, 0);
      if (date < from) date.setFullYear(from.getFullYear() + 1);
      return date.toISOString();
    }
  }
  m = text.match(/в\s+течение\s+(\d+)\s+(\w+)/i);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase();
    const ms = unit.startsWith('мин') ? 60e3 : unit.startsWith('час') ? 3600e3 : unit.startsWith('ден') || unit.startsWith('раб') ? 86400e3 : unit.startsWith('нед') ? 604800e3 : 86400e3;
    return new Date(from.getTime() + n * ms).toISOString();
  }
  for (const [dayName, dow] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`до\\s+${dayName}|к\\s+${dayName}`, 'i').test(text)) {
      const date = new Date(from);
      let delta = (dow - date.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      date.setDate(date.getDate() + delta);
      date.setHours(18, 0, 0, 0);
      return date.toISOString();
    }
  }
  if (/на следующей неделе/i.test(text)) {
    const date = new Date(from.getTime() + 7 * 86400e3);
    date.setHours(18, 0, 0, 0);
    return date.toISOString();
  }
  return null;
}

function extractAgreements(transcript, callId) {
  const out = [];
  if (!transcript) return out;
  const triggers = db.settings.agreementTriggers;
  const sentences = transcript.split(/(?<=[.!?])\s+|,\s+(?=[а-яёa-z])/i).filter(Boolean);
  for (const sent of sentences) {
    const low = sent.toLowerCase();
    if (!triggers.some((tr) => low.includes(tr))) continue;
    const dueAt = parseDueDate(sent); // исходный регистр: «КП» ≠ «кп» (аббревиатуры)
    const action = sent.trim().replace(/^["«]|["»]$/g, '').slice(0, 200);
    if (out.some((a) => a.action.toLowerCase() === action.toLowerCase())) continue;
    out.push({
      id: crypto.randomUUID(),
      callId: callId || null,
      action,
      dueAt,                       // ISO или null — «уточнить срок»
      needsDateConfirmation: !dueAt,
      status: 'open',              // open | done | overdue
      createdAt: nowIso()
    });
  }
  return out;
}

function detectTransferRequest(transcript) {
  const phrase = (db.settings.priorityRules.transferPhrase || '').toLowerCase();
  return !!transcript && !!phrase && transcript.toLowerCase().includes(phrase);
}

// ---------------------------------------------------------------------------
// Telegram-уведомления (CJM 1: уведомление о звонке + расшифровка + резюме)
// ---------------------------------------------------------------------------
async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return { ok: false, skipped: true, reason: 'Telegram не настроен (.env)' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000)
    });
    const json = await res.json();
    return { ok: !!json.ok, raw: json };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function formatCallNotification(call, agreements) {
  const lines = [
    `📞 Входящий звонок: ${call.caller || 'номер неизвестен'}`,
    `Категория: ${call.category} | Приоритет: ${call.priority}`,
    `Резюме: ${call.summary}`
  ];
  if (call.transcript) lines.push(`Расшифровка: ${String(call.transcript).slice(0, 500)}`);
  if (agreements && agreements.length) {
    lines.push('', '📝 Договорённости:');
    for (const a of agreements) {
      lines.push(`• ${a.action}${a.dueAt ? ` — срок ${new Date(a.dueAt).toLocaleDateString('ru-RU')}` : ' — ⚠️ срок не распознан, подтвердите'}`);
    }
  }
  if (call.needsHumanTransfer) lines.push('', '🚨 Звонящий запросил соединение с человеком!');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// SLA: просрочка обязательств (CJM 2: «вовремя выполнять обязательства»)
// ---------------------------------------------------------------------------
function refreshOverdue() {
  const now = Date.now();
  let changed = false;
  for (const a of db.agreements) {
    if (a.status === 'open' && a.dueAt && new Date(a.dueAt).getTime() < now) {
      a.status = 'overdue';
      changed = true;
    }
  }
  if (changed) saveDb();
  return changed;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function parseBody(raw, contentType) {
  if (!raw) return {};
  if ((contentType || '').includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try { return JSON.parse(raw); } catch (e) { return { raw }; }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  let file = urlPath === '/' ? '/index.html' : urlPath;
  file = path.normalize(path.join(PUBLIC_DIR, file));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': (mime[path.extname(file)] || 'application/octet-stream') + '; charset=utf-8' });
    res.end(buf);
  });
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

route('GET', /^\/api\/health$/, (req, res) => {
  json(res, 200, {
    ok: true,
    time: nowIso(),
    calls: db.calls.length,
    agreementsOpen: db.agreements.filter((a) => a.status !== 'done').length,
    telegramConfigured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    routingMode: db.settings.routingMode
  });
});

route('GET', /^\/api\/calls$/, (req, res) => json(res, 200, db.calls));

route('POST', /^\/api\/calls$/, async (req, res) => {
  const body = parseBody(await readBody(req), req.headers['content-type']);
  const call = {
    id: body.id || crypto.randomUUID(),
    caller: normalizePhone(body.caller || body.phone) || body.caller || null,
    callee: body.callee || null,
    status: body.status || 'completed',
    category: body.category || 'неизвестно',
    priority: body.priority || 'normal',
    summary: body.summary || '',
    transcript: body.transcript || null,
    recordUrl: body.recordUrl || null,
    startedAt: body.startedAt || nowIso(),
    source: 'manual'
  };
  db.calls.unshift(call);
  saveDb();
  json(res, 201, call);
});

route('PATCH', /^\/api\/calls\/([\w-]+)$/, async (req, res, id) => {
  const call = db.calls.find((c) => c.id === id);
  if (!call) return json(res, 404, { error: 'звонок не найден' });
  const body = parseBody(await readBody(req), req.headers['content-type']);
  for (const k of ['category', 'priority', 'summary', 'transcript', 'status']) {
    if (body[k] !== undefined) call[k] = body[k];
  }
  // ручная корректировка результатов ИИ (CJM 1 этап 4, CJM 2 этап 4)
  if (body.transcript !== undefined) {
    call.agreements = extractAgreements(body.transcript, call.id);
    db.agreements = db.agreements.filter((a) => a.callId !== call.id).concat(call.agreements);
  }
  saveDb();
  json(res, 200, call);
});

route('DELETE', /^\/api\/calls\/([\w-]+)$/, (req, res, id) => {
  const i = db.calls.findIndex((c) => c.id === id);
  if (i < 0) return json(res, 404, { error: 'звонок не найден' });
  db.calls.splice(i, 1);
  db.agreements = db.agreements.filter((a) => a.callId !== id);
  saveDb();
  json(res, 200, { deleted: id });
});

// Перевести звонок в Telegram-чат (CJM 1 этап 3: маршрутизация)
route('POST', /^\/api\/calls\/([\w-]+)\/telegram$/, async (req, res, id) => {
  const call = db.calls.find((c) => c.id === id);
  if (!call) return json(res, 404, { error: 'звонок не найден' });
  call.telegramSentAt = nowIso();
  saveDb();
  const result = await sendTelegram(formatCallNotification(call, db.agreements.filter((a) => a.callId === call.id)));
  json(res, 200, { sent: result.ok, detail: result });
});

// Экстренный перевод на человека по команде звонящего (CJM 1: «соедините с менеджером»)
route('POST', /^\/api\/calls\/([\w-]+)\/transfer-human$/, async (req, res, id) => {
  const call = db.calls.find((c) => c.id === id);
  if (!call) return json(res, 404, { error: 'звонок не найден' });
  call.needsHumanTransfer = true;
  call.priority = 'high';
  call.humanTransferRequestedAt = nowIso();
  saveDb();
  const result = await sendTelegram(`🚨 СРОЧНО: ${call.caller || 'неизвестный'} требует соединения с человеком.\nРезюме: ${call.summary || '—'}\nПожалуйста, перезвоните.`);
  json(res, 200, { queued: true, note: 'Реальный live-transfer требует команды Management API ВАТС МТС (см. README, раздел «следующий этап»).', telegram: result });
});

// Договорённости (CJM 2)
route('GET', /^\/api\/agreements$/, (req, res, url) => {
  refreshOverdue();
  const status = url.searchParams.get('status');
  const list = status ? db.agreements.filter((a) => a.status === status) : db.agreements;
  json(res, 200, list);
});

route('PATCH', /^\/api\/agreements\/([\w-]+)$/, async (req, res, id) => {
  const a = db.agreements.find((x) => x.id === id);
  if (!a) return json(res, 404, { error: 'договорённость не найдена' });
  const body = parseBody(await readBody(req), req.headers['content-type']);
  if (body.status) a.status = body.status;                       // done/open
  if (body.action) a.action = body.action;                        // ручная правка текста
  if (body.dueAt !== undefined) { a.dueAt = body.dueAt || null; a.needsDateConfirmation = !body.dueAt; }
  if (body.priority) a.priority = body.priority;
  if (body.tags) a.tags = body.tags;
  saveDb();
  json(res, 200, a);
});

// KPI и аналитика (CJM 2 этап 6: отчёты; CJM 1: статистика по звонкам)
route('GET', /^\/api\/stats$/, (req, res) => {
  refreshOverdue();
  const total = db.calls.length;
  const important = db.calls.filter((c) => c.priority === 'high').length;
  const byCategory = {};
  for (const c of db.calls) byCategory[c.category || 'неизвестно'] = (byCategory[c.category || 'неизвестно'] || 0) + 1;
  const agTotal = db.agreements.length;
  const agDone = db.agreements.filter((a) => a.status === 'done').length;
  const agOverdue = db.agreements.filter((a) => a.status === 'overdue').length;
  const missedPhrases = db.calls.filter((c) => c.needsHumanTransfer).length;
  json(res, 200, {
    calls: { total, important, byCategory, hotTransferRequests: missedPhrases },
    agreements: {
      total: agTotal,
      done: agDone,
      overdue: agOverdue,
      completionRate: agTotal ? Math.round((agDone / agTotal) * 100) : 0,
      onTimeRate: agTotal ? Math.round(((agTotal - agOverdue) / agTotal) * 100) : 0
    },
    transcriptionAccuracyTarget: db.settings.transcriptionAccuracyTarget
  });
});

// Экспорт договорённостей в CSV (CJM 2: «экспорт данных в Excel»)
route('GET', /^\/api\/agreements\.csv$/, (req, res) => {
  refreshOverdue();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['id', 'action', 'dueAt', 'status', 'callId', 'createdAt'].join(',')];
  for (const a of db.agreements) rows.push([a.id, esc(a.action), a.dueAt || '', a.status, a.callId || '', a.createdAt].join(','));
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="agreements.csv"' });
  res.end('\uFEFF' + rows.join('\n'));
});

// Настройки (CJM 1 этап 3: мастер настройки — приветствие, FAQ, маршрутизация, триггеры)
route('GET', /^\/api\/settings$/, (req, res) => json(res, 200, db.settings));

route('PUT', /^\/api\/settings$/, async (req, res) => {
  const body = parseBody(await readBody(req), req.headers['content-type']);
  // deep-merge по вложенным объектам (priorityRules и т.п.), чтобы не затирать соседние поля
  const merged = { ...db.settings };
  for (const [k, v] of Object.entries(body)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && merged[k] && typeof merged[k] === 'object' && !Array.isArray(merged[k])) {
      merged[k] = { ...merged[k], ...v };
    } else {
      merged[k] = v;
    }
  }
  db.settings = merged;
  saveDb();
  json(res, 200, db.settings);
});

// Reminder-проверка: что просрочено / скоро дедлайн (CJM 2 этап 5: уведомления о сроках)
route('GET', /^\/api\/reminders$/, (req, res) => {
  refreshOverdue();
  const soonMs = db.settings.reminderBeforeHours * 3600e3;
  const now = Date.now();
  const upcoming = db.agreements.filter((a) => a.status === 'open' && a.dueAt &&
    new Date(a.dueAt).getTime() - now <= soonMs && new Date(a.dueAt).getTime() >= now);
  const overdue = db.agreements.filter((a) => a.status === 'overdue');
  json(res, 200, { upcoming, overdue });
});

// Callback от МТС ВАТС
async function handleCallback(req, res, preParsed) {
  const rawPayload = preParsed !== undefined ? preParsed : parseBody(await readBody(req), req.headers['content-type']);
  const qs = req._url.searchParams;
  const merged = { ...Object.fromEntries(qs.entries()), ...(typeof rawPayload === 'object' ? rawPayload : {}) };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(EVENTS_FILE, JSON.stringify({ receivedAt: nowIso(), payload: merged }) + '\n');
  db.eventsCount = (db.eventsCount || 0) + 1;

  const ev = normalizeEvent(merged);
  const { category, priority } = classifyCall(ev.transcript);
  const agreements = extractAgreements(ev.transcript, ev.callId);

  const call = {
    id: ev.callId,
    caller: ev.caller,
    callee: ev.callee,
    status: ev.status,
    category,
    priority,
    summary: summarize(ev.transcript),
    transcript: ev.transcript || null,
    recordUrl: ev.recordUrl || null,
    startedAt: ev.startedAt,
    durationSec: ev.durationSec,
    source: 'mts',
    needsHumanTransfer: detectTransferRequest(ev.transcript)
  };
  const existing = db.calls.findIndex((c) => c.id === call.id);
  if (existing >= 0) db.calls[existing] = { ...db.calls[existing], ...call };
  else db.calls.unshift(call);
  db.agreements = db.agreements.filter((a) => a.callId !== call.id).concat(agreements);
  saveDb();

  // Уведомление в Telegram (CJM 1 этап 4: «получает уведомление о первом звонке»)
  const notify = await sendTelegram(formatCallNotification(call, agreements));

  json(res, 200, { accepted: true, callId: call.id, agreementsFound: agreements.length, telegramNotified: !!notify.ok });
}

route(['GET', 'POST'], /^\/api\/mts\/callback$/, handleCallback);
route('POST', /^\/api\/mts\/test-event$/, async (req, res) => {
  const testPayload = {
    call_id: 'demo-' + Date.now(),
    caller: '+375291112233',
    status: 'answered',
    transcript: 'Здравствуйте, это клиент. Пришлите КП до 15.10, обсудим поставку оргтехники. Если нужно — соедините с менеджером.',
    duration: 180
  };
  if (req.headers['content-type'] === 'application/json') {
    try { Object.assign(testPayload, JSON.parse(await readBody(req)) || {}); } catch (e) { /* игнорируем некорректный body */ }
  }
  req._url = new URL(req.url, 'http://localhost');
  await handleCallback(req, res, testPayload);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  req._url = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // секрет для callback (MTS_CALLBACK_SECRET задаётся в .env и в URL ВАТС)
  if (url.pathname === '/api/mts/callback' && process.env.MTS_CALLBACK_SECRET) {
    if (url.searchParams.get('secret') !== process.env.MTS_CALLBACK_SECRET) {
      return json(res, 401, { error: 'bad secret' });
    }
  }

  for (const r of routes) {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    if (!methods.includes(req.method)) continue;
    const m = url.pathname.match(r.pattern);
    if (m) {
      try {
        const args = m.slice(1);
        // хендлеры без параметров пути получают (req, res, url), с параметрами — (req, res, ...params, url)
        await (args.length ? r.handler(req, res, ...args, url) : r.handler(req, res, url));
      } catch (e) {
        json(res, 500, { error: String(e.message || e) });
      }
      return;
    }
  }

  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint' });
  return serveStatic(req, res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`MTS CallGuard backend: http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/api/health`);
});

module.exports = { server, normalizePhone, parseDueDate, extractAgreements, classifyCall };
