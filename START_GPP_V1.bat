@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js chua co tren may. Dang mo ban web truc tiep...
  start "" index.html
  echo De camera/PWA hoat dong day du, hay dua thu muc nay len static hosting hoac cai Node.js roi chay lai file nay.
  pause
  exit /b
)
start "GPP Data Entry Lite V1.2" cmd /c "node server.js"
timeout /t 2 /nobreak >nul
start "" http://localhost:8787
