const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

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
          await this.handleApi(msg, webviewView);
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
      }
    });

    webviewView.onDidDispose(() => { this.view = null; });
  }

  async handleApi(msg, webviewView) {
    const { endpoint, apiKey, model, messages } = msg;
    const url = new URL(endpoint);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const body = JSON.stringify({
      model: model,
      messages: messages,
      max_tokens: 4096,
      stream: false
    });

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 120000
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const content = json.choices?.[0]?.message?.content || json.error?.message || data;
          webviewView.webview.postMessage({ type: 'apiResponse', id: msg.id, content });
        } catch {
          webviewView.webview.postMessage({ type: 'apiResponse', id: msg.id, content: data });
        }
      });
    });

    req.on('error', (e) => {
      webviewView.webview.postMessage({ type: 'apiResponse', id: msg.id, content: 'Error: ' + e.message });
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
          // Binary file - read as base64
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
      fs.writeFileSync(msg.path, msg.content, 'utf8');
      webviewView.webview.postMessage({ type: 'fileSaved', path: msg.path, ok: true });
    } catch (e) {
      webviewView.webview.postMessage({ type: 'fileSaved', path: msg.path, ok: false, error: e.message });
    }
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
