@echo off
cd /d "%~dp0"
where node >NUL 2>NUL
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.org, then double-click this file again.
  pause
  exit /b 1
)
node deploy.js
echo.
pause
