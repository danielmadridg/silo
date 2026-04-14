import * as vscode from 'vscode';
import { streamChat, streamAnalysis } from '../backend';
import { collectProjectContext, getActiveFileInfo } from '../contextCollector';

const MODELS = [
  'qwen2.5-coder:32b',
  'qwen2.5-coder:14b',
  'qwen2.5-coder:7b',
  'qwen2.5:14b',
  'llama3.1:8b',
  'mistral:7b',
];

export class SiloChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'silo.chatView';
  private _view?: vscode.WebviewView;
  private history: { role: string; content: string }[] = [];
  private _currentModel: string = 'qwen2.5-coder:32b';
  private _fileIncluded: boolean = true;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'chat': await this.handleChat(msg.text, msg.imageData); break;
        case 'analyze': await this.handleAnalyze(); break;
        case 'clear': this.history = []; break;
        case 'toggleFile':
          this._fileIncluded = !this._fileIncluded;
          this.pushFileState(webviewView.webview);
          break;
        case 'setModel':
          this._currentModel = msg.model;
          await this.updateBackendModel(msg.model);
          break;
        case 'getModels':
          webviewView.webview.postMessage({ type: 'models', models: MODELS, current: this._currentModel });
          break;
        case 'getFileState':
          this.pushFileState(webviewView.webview);
          break;
      }
    });

    // Push active file info on focus
    vscode.window.onDidChangeActiveTextEditor(() => this.pushFileState(webviewView.webview));
  }

  private pushFileState(webview: vscode.Webview) {
    const editor = vscode.window.activeTextEditor;
    const filename = editor ? vscode.workspace.asRelativePath(editor.document.fileName) : null;
    webview.postMessage({ type: 'fileState', filename, included: this._fileIncluded });
  }

  private async updateBackendModel(model: string) {
    const backendUrl = vscode.workspace.getConfiguration('silo').get('backendUrl', 'http://127.0.0.1:8942');
    try {
      await fetch(`${backendUrl}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
    } catch { /* backend might not be running */ }
  }

  public async handleChat(text: string, imageData?: string) {
    if (!this._view) return;
    const fileContext = this._fileIncluded ? await collectProjectContext() : '';
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

  private getHtml(webview: vscode.Webview): string {
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'silologonobg.svg')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Silo</title>
<style>
  :root {
    --bg: #080705;
    --surface: #13110e;
    --surface2: #1c1914;
    --gold: #C4A165;
    --gold-dim: #8a6f43;
    --text: #F0EBE0;
    --text-dim: #9a9080;
    --border: #2a2518;
    --radius: 12px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--vscode-font-family), -apple-system, sans-serif;
    font-size: 13px;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  /* ── Messages ── */
  #messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px 10px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  #messages::-webkit-scrollbar { width: 4px; }
  #messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  /* Empty state */
  #empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    opacity: 0.9;
  }
  #empty-state img { width: 56px; height: 56px; object-fit: contain; }
  #empty-state span { color: var(--text-dim); font-size: 12px; }

  .msg { display: flex; flex-direction: column; gap: 2px; max-width: 100%; }
  .msg-user { align-items: flex-end; }
  .msg-assistant { align-items: flex-start; }

  .bubble {
    padding: 9px 13px;
    border-radius: var(--radius);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    font-size: 12.5px;
  }
  .bubble-user {
    background: var(--surface2);
    border: 1px solid var(--border);
    color: var(--text);
    border-bottom-right-radius: 4px;
  }
  .bubble-assistant {
    background: transparent;
    color: var(--text);
    border-bottom-left-radius: 4px;
    padding-left: 0;
  }
  .bubble-assistant.cursor::after {
    content: '▌';
    color: var(--gold);
    animation: blink 1s step-end infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }

  .img-preview-msg {
    max-width: 180px;
    border-radius: 8px;
    border: 1px solid var(--border);
    margin-bottom: 4px;
  }

  /* ── Bottom toolbar ── */
  #bottom {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  /* File badge */
  #file-badge {
    display: none;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    width: fit-content;
    max-width: 100%;
    transition: border-color 0.15s;
  }
  #file-badge:hover { border-color: var(--gold-dim); }
  #file-badge .file-icon { font-size: 10px; color: var(--gold); }
  #file-badge .file-name { font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 160px; }
  #file-badge .file-toggle { font-size: 10px; color: var(--gold-dim); margin-left: 2px; }
  #file-badge.excluded { opacity: 0.4; }

  /* Image preview in input */
  #img-preview-wrap {
    display: none;
    padding: 4px 0;
  }
  #img-preview-wrap.has-img { display: flex; align-items: center; gap: 6px; }
  #img-preview { height: 48px; border-radius: 6px; border: 1px solid var(--border); }
  #img-remove { background: none; border: none; color: var(--text-dim); cursor: pointer; font-size: 14px; padding: 0; }

  /* Input box */
  #input-box {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 8px 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: border-color 0.15s;
  }
  #input-box:focus-within { border-color: var(--gold-dim); }

  #input {
    background: transparent;
    border: none;
    outline: none;
    color: var(--text);
    font-family: inherit;
    font-size: 12.5px;
    resize: none;
    line-height: 1.5;
    min-height: 18px;
    max-height: 120px;
    overflow-y: auto;
    width: 100%;
    scrollbar-width: thin;
  }
  #input::placeholder { color: var(--text-dim); }

  .input-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .input-actions-right { margin-left: auto; display: flex; align-items: center; gap: 4px; }

  .icon-btn {
    background: none;
    border: none;
    color: var(--text-dim);
    cursor: pointer;
    padding: 3px 5px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    transition: color 0.15s, background 0.15s;
    position: relative;
  }
  .icon-btn:hover { color: var(--text); background: var(--surface2); }
  .icon-btn.active { color: var(--gold); }

  .mode-btn-label {
    font-size: 10px;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 3px;
  }
  .mode-btn-label svg { width: 13px; height: 13px; }

  .send-btn {
    background: var(--gold);
    border: none;
    color: var(--bg);
    cursor: pointer;
    padding: 4px 7px;
    border-radius: 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: opacity 0.15s;
  }
  .send-btn:hover { opacity: 0.85; }
  .send-btn:disabled { opacity: 0.3; cursor: default; }

  /* ── Dropdowns ── */
  .dropdown {
    position: fixed;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 4px;
    z-index: 999;
    min-width: 200px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    display: none;
  }
  .dropdown.open { display: block; }
  .dropdown-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 7px;
    cursor: pointer;
    color: var(--text);
    font-size: 12px;
    transition: background 0.1s;
  }
  .dropdown-item:hover { background: var(--surface); }
  .dropdown-item.active { color: var(--gold); }
  .dropdown-item .di-icon { font-size: 14px; width: 18px; text-align: center; }
  .dropdown-item .di-text { display: flex; flex-direction: column; }
  .dropdown-item .di-title { font-size: 12px; font-weight: 500; }
  .dropdown-item .di-desc { font-size: 10px; color: var(--text-dim); margin-top: 1px; }
  .dropdown-check { margin-left: auto; color: var(--gold); font-size: 12px; }
  .dropdown-sep { height: 1px; background: var(--border); margin: 4px 0; }

  /* Model dropdown item */
  .model-tag {
    font-size: 9px;
    background: var(--surface);
    color: var(--gold-dim);
    padding: 1px 5px;
    border-radius: 4px;
    margin-left: auto;
    border: 1px solid var(--border);
  }

  /* Effort slider */
  .effort-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    font-size: 11px;
    color: var(--text-dim);
  }
  .effort-dots { display: flex; gap: 4px; margin-left: auto; }
  .effort-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--border); cursor: pointer; transition: background 0.15s;
  }
  .effort-dot.on { background: var(--gold); }
</style>
</head>
<body>

<!-- Empty state shown when no messages -->
<div id="empty-state">
  <img src="${logoUri}" alt="Silo" />
  <span>Ask Silo anything about your code</span>
</div>

<!-- Messages -->
<div id="messages" style="display:none"></div>

<!-- Bottom -->
<div id="bottom">
  <!-- File badge -->
  <div id="file-badge" title="Click to toggle file context">
    <span class="file-icon">📄</span>
    <span class="file-name" id="file-name-label">—</span>
    <span class="file-toggle" id="file-toggle-icon">✕</span>
  </div>

  <!-- Input box -->
  <div id="input-box">
    <!-- Image preview -->
    <div id="img-preview-wrap">
      <img id="img-preview" src="" alt="" />
      <button id="img-remove" title="Remove image">✕</button>
    </div>

    <textarea id="input" rows="1" placeholder="Ask Silo..."></textarea>

    <div class="input-actions">
      <!-- + button -->
      <button class="icon-btn" id="plus-btn" title="Add context">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>

      <div class="input-actions-right">
        <!-- Mode selector -->
        <button class="icon-btn mode-btn-label" id="mode-btn" title="Mode">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
          <span id="mode-label">Ask</span>
        </button>

        <!-- Model selector -->
        <button class="icon-btn" id="model-btn" title="Switch model" style="font-size:10px; gap:2px;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/></svg>
          <span id="model-label">32b</span>
        </button>

        <!-- Send -->
        <button class="send-btn" id="send-btn" title="Send (Enter)">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
        </button>
      </div>
    </div>
  </div>
</div>

<!-- + Dropdown -->
<div class="dropdown" id="plus-menu">
  <div class="dropdown-item" id="add-image-btn">
    <span class="di-icon">🖼️</span>
    <div class="di-text">
      <span class="di-title">Add image</span>
      <span class="di-desc">Attach a screenshot or diagram</span>
    </div>
  </div>
  <div class="dropdown-item" id="add-file-btn">
    <span class="di-icon">📎</span>
    <div class="di-text">
      <span class="di-title">Add file context</span>
      <span class="di-desc">Include current file in prompt</span>
    </div>
  </div>
  <div class="dropdown-item" id="search-web-btn">
    <span class="di-icon">🔍</span>
    <div class="di-text">
      <span class="di-title">Search web</span>
      <span class="di-desc">Add web search results as context</span>
    </div>
  </div>
</div>

<!-- Mode Dropdown -->
<div class="dropdown" id="mode-menu">
  <div class="dropdown-item mode-item active" data-mode="ask">
    <span class="di-icon">🤚</span>
    <div class="di-text">
      <span class="di-title">Ask before edits</span>
      <span class="di-desc">Silo will ask for approval before each edit</span>
    </div>
    <span class="dropdown-check">✓</span>
  </div>
  <div class="dropdown-item mode-item" data-mode="auto">
    <span class="di-icon">&lt;/&gt;</span>
    <div class="di-text">
      <span class="di-title">Edit automatically</span>
      <span class="di-desc">Applies edits to selected text or file</span>
    </div>
    <span class="dropdown-check" style="display:none">✓</span>
  </div>
  <div class="dropdown-item mode-item" data-mode="plan">
    <span class="di-icon">📋</span>
    <div class="di-text">
      <span class="di-title">Plan mode</span>
      <span class="di-desc">Explores code and presents a plan first</span>
    </div>
    <span class="dropdown-check" style="display:none">✓</span>
  </div>
  <div class="dropdown-item mode-item" data-mode="bypass">
    <span class="di-icon">⛓️</span>
    <div class="di-text">
      <span class="di-title">Bypass permissions</span>
      <span class="di-desc">Runs commands without asking</span>
    </div>
    <span class="dropdown-check" style="display:none">✓</span>
  </div>
  <div class="dropdown-sep"></div>
  <div class="effort-row">
    <span>Effort</span>
    <div class="effort-dots">
      <div class="effort-dot" data-e="0"></div>
      <div class="effort-dot on" data-e="1"></div>
      <div class="effort-dot" data-e="2"></div>
      <div class="effort-dot" data-e="3"></div>
    </div>
  </div>
</div>

<!-- Model Dropdown -->
<div class="dropdown" id="model-menu"></div>

<input type="file" id="file-input" accept="image/*" style="display:none">

<script>
  const vscode = acquireVsCodeApi();

  // ── State ──
  let pendingImage = null;
  let currentMode = 'ask';
  const modeLabels = { ask: 'Ask', auto: 'Auto', plan: 'Plan', bypass: 'Free' };

  // ── Elements ──
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send-btn');
  const messages = document.getElementById('messages');
  const emptyState = document.getElementById('empty-state');
  const fileBadge = document.getElementById('file-badge');
  const fileNameLabel = document.getElementById('file-name-label');
  const fileToggleIcon = document.getElementById('file-toggle-icon');
  const imgPreviewWrap = document.getElementById('img-preview-wrap');
  const imgPreview = document.getElementById('img-preview');
  const modelLabel = document.getElementById('model-label');
  const modeLabel = document.getElementById('mode-label');

  // ── Auto-resize textarea ──
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // ── Paste image ──
  input.addEventListener('paste', e => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        const reader = new FileReader();
        reader.onload = ev => setImage(ev.target.result);
        reader.readAsDataURL(file);
        return;
      }
    }
  });

  function setImage(dataUrl) {
    pendingImage = dataUrl;
    imgPreview.src = dataUrl;
    imgPreviewWrap.classList.add('has-img');
  }

  document.getElementById('img-remove').onclick = () => {
    pendingImage = null;
    imgPreview.src = '';
    imgPreviewWrap.classList.remove('has-img');
  };

  // ── Send ──
  function send() {
    const text = input.value.trim();
    if (!text && !pendingImage) return;
    addUserMessage(text, pendingImage);
    vscode.postMessage({ type: 'chat', text, imageData: pendingImage });
    input.value = '';
    input.style.height = 'auto';
    pendingImage = null;
    imgPreview.src = '';
    imgPreviewWrap.classList.remove('has-img');
  }
  sendBtn.onclick = send;

  // ── Messages ──
  let currentBubble = null;

  function showMessages() {
    emptyState.style.display = 'none';
    messages.style.display = 'flex';
  }

  function addUserMessage(text, imageData) {
    showMessages();
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-user';
    if (imageData) {
      const img = document.createElement('img');
      img.src = imageData;
      img.className = 'img-preview-msg';
      wrap.appendChild(img);
    }
    if (text) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble bubble-user';
      bubble.textContent = text;
      wrap.appendChild(bubble);
    }
    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'start') {
      showMessages();
      const wrap = document.createElement('div');
      wrap.className = 'msg msg-assistant';
      const bubble = document.createElement('div');
      bubble.className = 'bubble bubble-assistant cursor';
      bubble.textContent = msg.label || '';
      wrap.appendChild(bubble);
      messages.appendChild(wrap);
      currentBubble = bubble;
      messages.scrollTop = messages.scrollHeight;
    } else if (msg.type === 'token' && currentBubble) {
      currentBubble.textContent += msg.token;
      messages.scrollTop = messages.scrollHeight;
    } else if (msg.type === 'done' && currentBubble) {
      currentBubble.classList.remove('cursor');
      currentBubble = null;
    } else if (msg.type === 'fileState') {
      if (msg.filename) {
        fileBadge.style.display = 'flex';
        fileNameLabel.textContent = msg.filename;
        fileBadge.classList.toggle('excluded', !msg.included);
        fileToggleIcon.textContent = msg.included ? '✕' : '+';
      } else {
        fileBadge.style.display = 'none';
      }
    } else if (msg.type === 'models') {
      buildModelMenu(msg.models, msg.current);
    }
  });

  // ── File badge ──
  fileBadge.onclick = () => vscode.postMessage({ type: 'toggleFile' });

  // ── Dropdowns ──
  function positionDropdown(menu, btn) {
    const rect = btn.getBoundingClientRect();
    menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
    menu.style.left = rect.left + 'px';
  }

  function closeAll() {
    document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
  }

  document.addEventListener('click', e => {
    if (!e.target.closest('.dropdown') && !e.target.closest('.icon-btn') && !e.target.closest('.send-btn')) {
      closeAll();
    }
  });

  // + button
  document.getElementById('plus-btn').onclick = (e) => {
    e.stopPropagation();
    const menu = document.getElementById('plus-menu');
    const isOpen = menu.classList.contains('open');
    closeAll();
    if (!isOpen) { positionDropdown(menu, e.currentTarget); menu.classList.add('open'); }
  };

  document.getElementById('add-image-btn').onclick = () => {
    closeAll();
    document.getElementById('file-input').click();
  };
  document.getElementById('file-input').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setImage(ev.target.result);
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  document.getElementById('add-file-btn').onclick = () => {
    closeAll();
    vscode.postMessage({ type: 'toggleFile' });
  };

  document.getElementById('search-web-btn').onclick = () => {
    closeAll();
    const q = input.value.trim();
    if (q) {
      const text = input.value + ' [searching web...]';
      input.value = text;
    }
  };

  // Mode button
  document.getElementById('mode-btn').onclick = (e) => {
    e.stopPropagation();
    const menu = document.getElementById('mode-menu');
    const isOpen = menu.classList.contains('open');
    closeAll();
    if (!isOpen) { positionDropdown(menu, e.currentTarget); menu.classList.add('open'); }
  };

  document.querySelectorAll('.mode-item').forEach(item => {
    item.addEventListener('click', () => {
      currentMode = item.dataset.mode;
      modeLabel.textContent = modeLabels[currentMode];
      document.querySelectorAll('.mode-item').forEach(i => {
        i.classList.remove('active');
        i.querySelector('.dropdown-check').style.display = 'none';
      });
      item.classList.add('active');
      item.querySelector('.dropdown-check').style.display = 'block';
      closeAll();
    });
  });

  // Effort dots
  let effort = 1;
  document.querySelectorAll('.effort-dot').forEach(dot => {
    dot.onclick = () => {
      effort = parseInt(dot.dataset.e);
      document.querySelectorAll('.effort-dot').forEach((d, i) => d.classList.toggle('on', i <= effort));
    };
  });

  // Model button
  document.getElementById('model-btn').onclick = (e) => {
    e.stopPropagation();
    const menu = document.getElementById('model-menu');
    const isOpen = menu.classList.contains('open');
    closeAll();
    if (!isOpen) {
      vscode.postMessage({ type: 'getModels' });
      positionDropdown(menu, e.currentTarget);
      menu.classList.add('open');
    }
  };

  function buildModelMenu(models, current) {
    const menu = document.getElementById('model-menu');
    menu.innerHTML = '';
    models.forEach(m => {
      const item = document.createElement('div');
      item.className = 'dropdown-item' + (m === current ? ' active' : '');
      const shortName = m.split(':')[0].replace('qwen2.5-', 'qwen ').replace('llama', 'llama').replace('mistral', 'mistral');
      const tag = m.includes(':') ? m.split(':')[1] : '';
      item.innerHTML = \`
        <span class="di-icon">🤖</span>
        <div class="di-text"><span class="di-title">\${shortName}</span></div>
        \${tag ? \`<span class="model-tag">\${tag}</span>\` : ''}
        <span class="dropdown-check" style="\${m === current ? '' : 'display:none'}">✓</span>
      \`;
      item.onclick = () => {
        vscode.postMessage({ type: 'setModel', model: m });
        const short = m.split(':')[1] || m.split('/').pop();
        modelLabel.textContent = short;
        closeAll();
      };
      menu.appendChild(item);
    });
    // update current label
    const tag = current.includes(':') ? current.split(':')[1] : current;
    modelLabel.textContent = tag;
  }

  // ── Init ──
  vscode.postMessage({ type: 'getFileState' });
  vscode.postMessage({ type: 'getModels' });
</script>
</body>
</html>`;
  }
}
