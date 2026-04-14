import * as vscode from 'vscode';
import { streamChat, streamAnalysis } from '../backend';
import { collectProjectContext, getActiveFileInfo } from '../contextCollector';

export class SiloChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'silo.chatView';
  private _view?: vscode.WebviewView;
  private history: { role: string; content: string }[] = [];

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'chat') await this.handleChat(msg.text);
      if (msg.type === 'analyze') await this.handleAnalyze();
      if (msg.type === 'clear') this.history = [];
    });
  }

  public async handleChat(text: string) {
    if (!this._view) return;
    const fileContext = await collectProjectContext();
    this.history.push({ role: 'user', content: text });
    this._view.webview.postMessage({ type: 'start' });
    let full = '';
    await streamChat(text, this.history.slice(0, -1), fileContext, (token) => {
      full += token;
      this._view!.webview.postMessage({ type: 'token', token });
    });
    this.history.push({ role: 'assistant', content: full });
    this._view.webview.postMessage({ type: 'done' });
  }

  public async handleAnalyze() {
    if (!this._view) return;
    const info = getActiveFileInfo();
    if (!info) return;
    this._view.webview.postMessage({ type: 'start', label: `Analyzing ${info.filename}...` });
    let full = '';
    await streamAnalysis(info.code, info.filename, (token) => {
      full += token;
      this._view!.webview.postMessage({ type: 'token', token });
    });
    this.history.push({ role: 'assistant', content: full });
    this._view.webview.postMessage({ type: 'done' });
  }

  public async sendMessage(text: string) {
    if (!this._view) return;
    this._view.show(true);
    await this.handleChat(text);
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Silo</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
         font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
         height: 100vh; display: flex; flex-direction: column; }
  #messages { flex: 1; overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
  .msg { padding: 8px 10px; border-radius: 6px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; font-size: 12px; }
  .user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; max-width: 85%; }
  .assistant { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); align-self: flex-start; max-width: 95%; }
  #toolbar { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-top: 1px solid var(--vscode-widget-border); }
  #input { background: var(--vscode-input-background); color: var(--vscode-input-foreground);
           border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 6px;
           resize: none; font-family: inherit; font-size: 12px; width: 100%; }
  .btn-row { display: flex; gap: 4px; }
  button { flex: 1; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; border-radius: 4px; padding: 5px 8px; cursor: pointer; font-size: 11px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .cursor::after { content: '▌'; animation: blink 1s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
</style>
</head>
<body>
<div id="messages"></div>
<div id="toolbar">
  <textarea id="input" rows="3" placeholder="Ask Silo..."></textarea>
  <div class="btn-row">
    <button onclick="send()">Send</button>
    <button onclick="analyze()">Analyze</button>
    <button onclick="clearChat()">Clear</button>
  </div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  let currentMsg = null;

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  function send() {
    const text = input.value.trim();
    if (!text) return;
    addMessage('user', text);
    input.value = '';
    vscode.postMessage({ type: 'chat', text });
  }

  function analyze() { vscode.postMessage({ type: 'analyze' }); }
  function clearChat() { messages.innerHTML = ''; vscode.postMessage({ type: 'clear' }); }

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'start') {
      currentMsg = addMessage('assistant', msg.label || '');
      currentMsg.classList.add('cursor');
    } else if (msg.type === 'token' && currentMsg) {
      currentMsg.textContent += msg.token;
      messages.scrollTop = messages.scrollHeight;
    } else if (msg.type === 'done' && currentMsg) {
      currentMsg.classList.remove('cursor');
      currentMsg = null;
    }
  });
</script>
</body>
</html>`;
  }
}
