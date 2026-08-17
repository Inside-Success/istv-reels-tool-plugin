@echo off
REM ISTV Reel Tool - one-click updater for editors (Windows).
REM Double-click this file. It replaces the installed panel with this package.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if %errorlevel% neq 0 (
  echo.
  echo Update failed. See the message above.
)
echo.
pause
