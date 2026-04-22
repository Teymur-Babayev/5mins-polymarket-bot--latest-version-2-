@echo off
cd /d "%~dp0"
REM Ensure Node/npm are reachable even if PATH isn't set for this PowerShell session.
set "NPM_CMD="
if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"
if not defined NPM_CMD if exist "%ProgramFiles(x86)%\nodejs\npm.cmd" set "NPM_CMD=%ProgramFiles(x86)%\nodejs\npm.cmd"
if not defined NPM_CMD if exist "C:\Program Files\nodejs\npm.cmd" set "NPM_CMD=C:\Program Files\nodejs\npm.cmd"

if not defined NPM_CMD (
  echo ERROR: npm.cmd not found. Install Node.js or add C:\Program Files\nodejs to PATH.
  exit /b 1
)

REM Bypass PowerShell script restriction so npm works
powershell -NoProfile -ExecutionPolicy Bypass -Command "& '%NPM_CMD%' start"
