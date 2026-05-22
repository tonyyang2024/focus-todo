const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const http = require('http');

const SERVER_PORT = 3000;

class ChatViewProvider {
  constructor(extensionPath) {
    this.extensionPath = extensionPath;
    this.view = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.extensionPath))]
    };

    webviewView.title = 'Code Chat';

    const htmlPath = path.join(this.extensionPath, 'webview.html');
    let html = fs.readFileSync(htmlPath, 'utf8');
    webviewView.webview.html = html;

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'api':
          await this.handleChatStream(msg, webviewView);
          break;
        case 'openFile':
          await this.handleOpenFile(webviewView);
          break;
        case 'readFile':
          this.handleReadFile(msg.path, webviewView);
          break;
        case 'saveFile':
          this.handleSaveFile(msg, webviewView);
          break;
        case 'fetchConfig':
          this.handleFetchConfig(webviewView);
          break;
      }
    });

    webviewView.onDidDispose(() => { this.view = null; });
  }

  async handleChatStream(msg, webviewView) {
    const { id, model, messages, tools } = msg;

    const body = JSON.stringify({ messages, model, tools });
    const req = http.request({
      hostname: 'localhost',
      port: SERVER_PORT,
      path: '/api/chat/stream',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 300000
    }, (res) => {
      if (res.statusCode !== 200) {
        let errData = '';
        res.on('data', c => errData += c);
        res.on('end', () => {
          webviewView.webview.postMessage({
            type: 'apiResponse', id, content: `Server error ${res.statusCode}: ${errData.slice(0, 300)}`
          });
        });
        return;
      }

      let buffer = '';
      let content = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);

          try {
            const data = JSON.parse(dataStr);

            if (data.type === 'token') {
              content += data.text;
              webviewView.webview.postMessage({ type: 'apiToken', id, token: data.text });
            } else if (data.type === 'done') {
              webviewView.webview.postMessage({
                type: 'apiResponse', id,
                content: data.content || content,
                model: data.model
              });
            } else if (data.type === 'error') {
              webviewView.webview.postMessage({
                type: 'apiResponse', id,
                content: 'Error: ' + data.message
              });
            } else if (data.type === 'tool_call') {
              webviewView.webview.postMessage({
                type: 'toolCall', id,
                tool: data.tool, params: data.params
              });
            } else if (data.type === 'tool_result') {
              webviewView.webview.postMessage({
                type: 'toolResult', id,
                tool: data.tool, result: data.result
              });
            }
          } catch {}
        }
      });

      res.on('end', () => {
        // If no explicit done event was sent, send one with accumulated content
        if (content && !buffer) {
          // Already handled via done event
        }
      });

      res.on('error', (e) => {
        webviewView.webview.postMessage({
          type: 'apiResponse', id,
          content: 'Stream error: ' + e.message
        });
      });
    });

    req.on('error', (e) => {
      webviewView.webview.postMessage({
        type: 'apiResponse', id,
        content: 'Connection error: Cannot reach local server (port ' + SERVER_PORT + '). Is `node server.js` running?'
      });
    });

    req.on('timeout', () => {
      req.destroy();
      webviewView.webview.postMessage({
        type: 'apiResponse', id,
        content: 'Request timed out (5 min)'
      });
    });

    req.write(body);
    req.end();
  }

  async handleOpenFile(webviewView) {
    const files = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: '添加附件',
      filters: { '所有文件': ['*'] }
    });
    if (files && files.length > 0) {
      for (const f of files) {
        try {
          const content = fs.readFileSync(f.fsPath, 'utf8');
          const stat = fs.statSync(f.fsPath);
          webviewView.webview.postMessage({
            type: 'fileOpened',
            name: path.basename(f.fsPath),
            path: f.fsPath,
            content: content.slice(0, 50000),
            size: stat.size,
            truncated: content.length > 50000
          });
        } catch (e) {
          try {
            const buf = fs.readFileSync(f.fsPath);
            const base64 = buf.toString('base64');
            const isImage = /\.(png|jpg|jpeg|gif|webp|bmp|svg)$/i.test(f.fsPath);
            webviewView.webview.postMessage({
              type: 'fileOpened',
              name: path.basename(f.fsPath),
              path: f.fsPath,
              content: isImage ? `data:image/${path.extname(f.fsPath).slice(1)};base64,${base64}` : `[Binary file: ${buf.length} bytes]`,
              size: buf.length,
              isImage,
              isBinary: true
            });
          } catch (e2) {
            webviewView.webview.postMessage({
              type: 'fileOpened',
              name: path.basename(f.fsPath),
              path: f.fsPath,
              content: '[无法读取]',
              error: e2.message
            });
          }
        }
      }
    }
  }

  handleReadFile(filePath, webviewView) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      webviewView.webview.postMessage({
        type: 'fileContent',
        path: filePath,
        content: content.slice(0, 50000),
        truncated: content.length > 50000
      });
    } catch (e) {
      webviewView.webview.postMessage({
        type: 'fileContent',
        path: filePath,
        content: '',
        error: e.message
      });
    }
  }

  handleSaveFile(msg, webviewView) {
    try {
      const fullPath = path.isAbsolute(msg.path) ? msg.path : path.join(this.extensionPath, '..', '..', msg.path);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, msg.content, 'utf8');
      webviewView.webview.postMessage({ type: 'fileSaved', path: msg.path, ok: true });
    } catch (e) {
      webviewView.webview.postMessage({ type: 'fileSaved', path: msg.path, ok: false, error: e.message });
    }
  }

  handleFetchConfig(webviewView) {
    const req = http.get({
      hostname: 'localhost',
      port: SERVER_PORT,
      path: '/api/config/key',
      timeout: 5000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const cfg = JSON.parse(data);
          webviewView.webview.postMessage({ type: 'configLoaded', config: cfg });
        } catch {
          webviewView.webview.postMessage({ type: 'configLoaded', config: {} });
        }
      });
    });
    req.on('error', () => {
      webviewView.webview.postMessage({ type: 'configLoaded', config: {} });
    });
    req.on('timeout', () => {
      req.destroy();
      webviewView.webview.postMessage({ type: 'configLoaded', config: {} });
    });
  }

  show() {
    if (this.view) this.view.show(true);
  }
}

function activate(context) {
  const provider = new ChatViewProvider(context.extensionPath);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codechat.view', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('codechat.open', () => provider.show())
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
