@echo off
setlocal
cd /d "%~dp0"
title Nansen Smart Money Rotation Radar Launcher

where node >nul 2>nul || goto :missing_node
where npm >nul 2>nul || goto :missing_node

powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:5173; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  start "" http://127.0.0.1:5173
  exit /b 0
)

if not exist "node_modules\" (
  echo Installing dependencies for first use...
  call npm install || goto :install_failed
)

echo Starting Nansen Smart Money Rotation Radar...
start "Nansen Radar Servers" /D "%~dp0" cmd /k "npm run dev"

for /L %%I in (1,1,60) do (
  powershell -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:5173; if($r.StatusCode -eq 200){exit 0}else{exit 1} } catch { exit 1 }" >nul 2>nul
  if not errorlevel 1 goto :ready
  timeout /t 1 /nobreak >nul
)

echo ERROR: The dashboard did not become ready within 60 seconds.
echo Review the "Nansen Radar Servers" window for the startup error.
pause
exit /b 1

:ready
start "" http://127.0.0.1:5173
exit /b 0

:missing_node
echo ERROR: Node.js and npm are required but were not found.
echo Install the current Node.js LTS release from https://nodejs.org/ and try again.
pause
exit /b 1

:install_failed
echo ERROR: npm install failed. Check your internet connection and try again.
pause
exit /b 1
