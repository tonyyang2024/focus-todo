@echo off
chcp 65001 >nul
echo Starting SFTP Server...
echo.
cd /d "C:\workspace\yoohome-claudecloud"
node sftp-server.js
pause
