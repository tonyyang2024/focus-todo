# Yoohome ClaudeCloud 个人助手

基于 Claude Code + DeepSeek API 的个人 AI 编程助手工作区。

## 项目结构

```
yoohome-claudecloud/
├── CLAUDE.md              # 助手行为指南（人格、能力、偏好）
├── claudecloud.bat         # 一键启动 Claude Code 助手
├── open-chat.bat           # 启动独立聊天界面
├── chat-ui.html            # 独立 HTML 交互式编程界面
├── .claude/
│   └── settings.json       # 项目级配置（模型、权限、hooks）
├── .vscode/
│   ├── settings.json       # VS Code 工作区配置（终端自动启动助手）
│   ├── launch.json         # 扩展调试配置
│   └── chat-extension/     # VS Code 聊天面板扩展
│       ├── package.json
│       ├── extension.js
│       └── webview.html    # 支持语音输入的交互面板
└── memory/                 # 助手记忆系统（用户画像、偏好、项目背景）
```

## 启动方式

- **终端启动**: 双击 `claudecloud.bat` 或在工作区打开终端（VS Code 中已设为默认）
- **聊天面板**: 按 F5 启动 Code Chat 扩展调试
- **独立界面**: 双击 `open-chat.bat`

## 配置说明

所有行为配置在 `CLAUDE.md` 中，项目配置在 `.claude/settings.json` 中。记忆文件位于用户目录下的 `.claude/projects/` 对应项目路径中。
