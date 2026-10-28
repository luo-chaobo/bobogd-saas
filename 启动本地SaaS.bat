@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\start-local-saas.ps1"
echo.
echo SaaS service stopped or failed to start. See the message above.
pause
