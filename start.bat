@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запуск MTS CallGuard...
node server.js
pause
