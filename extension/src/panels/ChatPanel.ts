import * as vscode from 'vscode';
import { streamChat, streamAnalysis } from '../backend';
import { collectProjectContext, getActiveFileInfo } from '../contextCollector';

export class ChatPanel {
  static currentPanel: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private history: { role: string; content: string }[] = [];

  static createOrShow(_extensionUri: vscode.Uri) {
    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'siloChat', 'Silo Chat',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ChatPanel.currentPanel = new ChatPanel(panel);
  }

  constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => { ChatPanel.currentPanel = undefined; });
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'chat') await this.handleChat(msg.text);
      if (msg.type === 'analyze') await this.handleAnalyze();
      if (msg.type === 'clear') this.history = [];
    });
  }

  public async handleChat(text: string) {
    const fileContext = await collectProjectContext();
    this.history.push({ role: 'user', content: text });
    this.panel.webview.postMessage({ type: 'start', role: 'assistant' });
    let full = '';
    await streamChat(text, this.history.slice(0, -1), fileContext, (token) => {
      full += token;
      this.panel.webview.postMessage({ type: 'token', token });
    });
    this.history.push({ role: 'assistant', content: full });
    this.panel.webview.postMessage({ type: 'done' });
  }

  public async handleAnalyze() {
    const info = getActiveFileInfo();
    if (!info) return;
    this.panel.webview.postMessage({ type: 'start', role: 'assistant', label: `Analyzing ${info.filename}...` });
    let full = '';
    await streamAnalysis(info.code, info.filename, (token) => {
      full += token;
      this.panel.webview.postMessage({ type: 'token', token });
    });
    this.history.push({ role: 'assistant', content: full });
    this.panel.webview.postMessage({ type: 'done' });
  }

  public async sendExternalMessage(text: string) {
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
         font-family: var(--vscode-font-family); height: 100vh; display: flex; flex-direction: column; }
  #messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .msg { padding: 10px 14px; border-radius: 8px; max-width: 90%; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
  .user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; }
  .assistant { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); align-self: flex-start; }
  #toolbar { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--vscode-widget-border); }
  #input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
           border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 8px; resize: none; font-family: inherit; font-size: 13px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; border-radius: 4px; padding: 8px 14px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .cursor::after { content: '▌'; animation: blink 1s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; overflow-x: auto; margin: 4px 0; }
  code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
</style>
</head>
<body>
<div id="messages"></div>
<div id="toolbar">
  <textarea id="input" rows="3" placeholder="Ask Silo anything about your code..."></textarea>
  <div style="display:flex;flex-direction:column;gap:6px">
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
