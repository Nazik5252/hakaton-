@echo off
chcp 65001 >nul
cd /d "%~dp0"
for /f "tokens=1,* delims==" %%A in (.env) do (
  if "%%A"=="TELEGRAM_BOT_TOKEN" set BOT_TOKEN=%%B
)
if "%BOT_TOKEN%"=="" (
  echo Сначала укажите TELEGRAM_BOT_TOKEN в .env
  pause
  exit /b
)
start "" "https://api.telegram.org/bot%BOT_TOKEN%/getUpdates"
