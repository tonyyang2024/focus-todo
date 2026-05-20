@echo off
chcp 65001 >nul
cd /d C:\workspace\yoohome-claudecloud

echo.
echo  ╔══════════════════════════════════════╗
echo  ║     Yoohome ClaudeCloud 个人助手     ║
echo  ║     Claude Code + DeepSeek           ║
echo  ╚══════════════════════════════════════╝
echo.
echo  工作目录: %CD%
echo  启动时间: %date% %time%
echo.

REM 检查 Claude Code 是否安装
where claude >nul 2>nul
if %errorlevel% neq 0 (
    echo [警告] 未找到 claude 命令，请确认 Claude Code 已安装
    echo 安装方式: npm install -g @anthropic-ai/claude-code
    echo.
    pause
    exit /b 1
)

REM 显示 Claude Code 版本
echo [信息] Claude Code 版本:
claude --version 2>nul || echo   (无法获取版本号)
echo.

REM 启动 Claude Code 交互会话
echo [启动] 正在进入助手对话...
echo.
claude

endlocal
