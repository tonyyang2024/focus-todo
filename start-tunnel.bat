@echo off
REM Yoohome Public Tunnel — auto-restart on failure
cd /d C:\workspace\yoohome-claudecloud

:loop
echo [%date% %time%] Starting tunnel: https://yoohome.loca.lt
npx localtunnel --port 3000 --subdomain yoohome
echo [%date% %time%] Tunnel disconnected, restarting in 10s...
timeout /t 10 /nobreak >nul
goto loop
