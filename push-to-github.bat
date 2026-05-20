@echo off
chcp 65001 >nul
echo === Focus Todo - 推送到 GitHub ===
echo.

set /p GITHUB_USER="输入你的 GitHub 用户名: "
set /p REPO_NAME="输入仓库名 (如 focus-todo): "

echo.
echo 1. 初始化 Git...
git init
git checkout -b main 2>nul

echo 2. 添加文件...
git add package.json package-lock.json server.js db.js public/index.html railway.toml .gitignore

echo 3. 提交...
git commit -m "Todo + Pomodoro with multi-user accounts"

echo 4. 推送到 GitHub...
git remote add origin https://github.com/%GITHUB_USER%/%REPO_NAME%.git
git push -u origin main

echo.
echo === 完成! ===
echo 仓库地址: https://github.com/%GITHUB_USER%/%REPO_NAME%
echo 接下来去 railway.com 关联这个仓库即可部署
pause
