@echo off
chcp 65001 >nul
curl -X POST http://localhost:3000/api/mts/test-event ^
  -H "Content-Type: application/json" ^
  -d "{\"event\":\"call_finished\",\"call_id\":\"mts-test-001\",\"from\":\"+375291112233\",\"to\":\"+375290000000\",\"duration\":47,\"transcript\":\"Здравствуйте, хотим срочно обсудить партнерство и контракт до пятницы\"}"
echo.
pause
