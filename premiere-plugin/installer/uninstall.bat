@echo off
REM ISTV Reel Tool — uninstaller (Windows). Double-click to remove the panel.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
