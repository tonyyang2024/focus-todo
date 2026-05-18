# VS Code Voice AI 助手 — Windows 搭建指南

## 对标关系

| 功能 | macOS (你的文件) | Windows (本方案) |
|------|-----------------|-----------------|
| 语音识别 | Type4Me + SenseVoice 本地 ASR | **Win+H** Windows 内建听写 / Skill Copilot Web Speech |
| 文字注入 | Type4Me 注入到光标位置 | Win+H 直接输入 / Skill Copilot 输入框 |
| 自动发送 | autosubmit-watcher 检测注入→Enter | Skill Copilot 语音自动发送开关 |
| TTS 朗读 | voice-dialog MCP (edge-tts + afplay) | Skill Copilot Web Speech / Windows SAPI |
| 暂停朗读 | F8 → tts-pause-toggle.sh | 点击 Skill Copilot 喇叭按钮 |
| 快捷键 | F5 录音 | F5 可用 / Win+H 系统级听写 |

## 方案一：Win+H (最简单，零配置)

按 **Win+H** → 开始说话 → 文字出现在 VS Code Claude Code 输入框 → 手动 Enter 发送。

- 优点：不需要任何软件，Windows 自带
- 缺点：需要手动回车，没有 TTS 朗读回复

## 方案二：Skill Copilot (全功能，对标 macOS 管道)

打开 `http://localhost:3000/skill-copilot/` 或 `https://focus-todo-0svl.onrender.com/skill-copilot/`

功能：
- 点击麦克风按钮 → 说话 → 自动识别 → 自动发送给 AI
- AI 回复后自动 TTS 朗读（可开关）
- 13 个 AI Skills + 知识库 + 任务队列
- PWA 可添加到手机桌面

在 VS Code 中打开：
- **Ctrl+Shift+P** → 输入 `Simple Browser` → 输入 `http://localhost:3000/skill-copilot/`
- 或在浏览器中打开，与 VS Code 并排使用

## 方案三：PowerShell 语音 (高级用户)

运行本项目中的语音设置脚本：

```powershell
powershell -ExecutionPolicy Bypass -File voice-setup-windows.ps1
```

使用 Windows SAPI 进行 TTS 朗读。

## VS Code 快捷键配置

编辑 `keybindings.json` (Ctrl+Shift+P → Preferences: Open Keyboard Shortcuts JSON):

```json
[
  {
    "key": "ctrl+shift+v",
    "command": "simpleBrowser.show",
    "args": "http://localhost:3000/skill-copilot/"
  }
]
```

按 Ctrl+Shift+V 即可在 VS Code 内打开语音 AI 面板。

## 推荐工作流

```
┌─ VS Code (左) ─────────────┬─ Skill Copilot (右) ──────┐
│                             │                            │
│  Claude Code 面板           │  语音输入 + 自动发送       │
│  写代码 / 调试 / 文件操作   │  AI 回复 TTS 朗读         │
│                             │  知识库查询 / 任务提交    │
│                             │                            │
│  双向通信：                 │                            │
│  VS Code ← 知识库 API →     │  Skill Copilot             │
│  VS Code ← 任务队列 API →   │  Skill Copilot             │
└─────────────────────────────┴────────────────────────────┘
```
