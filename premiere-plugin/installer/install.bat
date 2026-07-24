@echo off
REM ISTV Reel Tool — one-click installer for editors (Windows).
REM Double-click this file. It runs install.ps1 with the right permissions.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if %errorlevel% neq 0 (
  echo.
  echo Install failed. See the message above.
)
echo.
pause
