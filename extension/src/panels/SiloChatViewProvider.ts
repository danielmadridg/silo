import * as vscode from 'vscode';
import { streamChat, streamAnalysis } from '../backend';
import { collectProjectContext, getActiveFileInfo } from '../contextCollector';

const MODELS = [
  { id: 'qwen2.5-coder:32b',  label: 'Qwen 2.5 Coder 32B', tier: 'High-end'  },
  { id: 'qwen2.5-coder:14b',  label: 'Qwen 2.5 Coder 14B', tier: 'Mid-range' },
  { id: 'qwen2.5-coder:7b',   label: 'Qwen 2.5 Coder 7B',  tier: 'Low-end'  },
  { id: 'deepseek-r1:7b',     label: 'DeepSeek R1 7B',      tier: 'Reasoning'},
];

interface Chat {
  id: string;
  title: string;
  history: { role: string; content: string }[];
  createdAt: number;
}

export class SiloChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'silo.chatView';
  private _view?: vscode.WebviewView;
  private _currentModel = 'qwen2.5-coder:32b';
  private _fileIncluded = true;
  private _currentChatId: string | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {}

  // ── Chat persistence ──────────────────────────────────────────
  private getChats(): Chat[] {
    return this._context.globalState.get<Chat[]>('silo.chats', []);
  }
  private saveChats(chats: Chat[]) {
    this._context.globalState.update('silo.chats', chats);
  }
  private getCurrentChat(): Chat | null {
    if (!this._currentChatId) return null;
    return this.getChats().find(c => c.id === this._currentChatId) ?? null;
  }
  private upsertChat(chat: Chat) {
    const chats = this.getChats().filter(c => c.id !== chat.id);
    this.saveChats([chat, ...chats].slice(0, 50));
  }
  private newChat(): Chat {
    const chat: Chat = { id: Date.now().toString(), title: 'New chat', history: [], createdAt: Date.now() };
    this.upsertChat(chat);
    this._currentChatId = chat.id;
    return chat;
  }

  // ── WebviewViewProvider ───────────────────────────────────────
  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'init':       this.onInit(); break;
        case 'chat':       await this.handleChat(msg.text, msg.imageData); break;
        case 'newChat':    this.startNewChat(); break;
        case 'loadChat':   this.loadChat(msg.id); break;
        case 'deleteChat': this.deleteChat(msg.id); break;
        case 'getHistory': this.sendHistory(); break;
        case 'toggleFile':
          this._fileIncluded = !this._fileIncluded;
          this.pushFileState(); break;
        case 'setModel':
          this._currentModel = msg.model;
          this.updateBackendModel(msg.model); break;
      }
    });

    vscode.window.onDidChangeActiveTextEditor(() => this.pushFileState());
  }

  private onInit() {
    // Restore last chat or create new
    const chats = this.getChats();
    if (chats.length > 0) {
      this._currentChatId = chats[0].id;
      this._view?.webview.postMessage({ type: 'loadMessages', history: chats[0].history, title: chats[0].title });
    } else {
      this.newChat();
    }
    this._view?.webview.postMessage({ type: 'models', models: MODELS, current: this._currentModel });
    this.pushFileState();
  }

  private startNewChat() {
    const chat = this.newChat();
    this._view?.webview.postMessage({ type: 'loadMessages', history: [], title: chat.title });
    this.pushFileState();
  }

  private loadChat(id: string) {
    const chat = this.getChats().find(c => c.id === id);
    if (!chat) return;
    this._currentChatId = id;
    this._view?.webview.postMessage({ type: 'loadMessages', history: chat.history, title: chat.title });
  }

  private deleteChat(id: string) {
    const chats = this.getChats().filter(c => c.id !== id);
    this.saveChats(chats);
    if (this._currentChatId === id) {
      if (chats.length > 0) {
        this.loadChat(chats[0].id);
      } else {
        this.startNewChat();
      }
    }
    this.sendHistory();
  }

  private sendHistory() {
    const chats = this.getChats().map(c => ({
      id: c.id, title: c.title, createdAt: c.createdAt,
      preview: c.history.find(m => m.role === 'user')?.content?.slice(0, 60) ?? 'Empty chat'
    }));
    this._view?.webview.postMessage({ type: 'history', chats, currentId: this._currentChatId });
  }

  private pushFileState() {
    const editor = vscode.window.activeTextEditor;
    const filename = editor ? vscode.workspace.asRelativePath(editor.document.fileName) : null;
    this._view?.webview.postMessage({ type: 'fileState', filename, included: this._fileIncluded });
  }

  private async updateBackendModel(model: string) {
    const url = vscode.workspace.getConfiguration('silo').get('backendUrl', 'http://127.0.0.1:8942');
    try { await fetch(`${url}/model`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ model }) }); }
    catch { /* backend offline */ }
  }

  public async handleChat(text: string, _imageData?: string) {
    if (!this._view) return;
    let chat = this.getCurrentChat();
    if (!chat) { chat = this.newChat(); }

    const fileContext = this._fileIncluded ? await collectProjectContext() : '';
    chat.history.push({ role: 'user', content: text });
    if (chat.title === 'New chat' && text) {
      chat.title = text.slice(0, 40) + (text.length > 40 ? '…' : '');
    }
    this.upsertChat(chat);

    this._view.webview.postMessage({ type: 'start' });
    let full = '';
    await streamChat(text, chat.history.slice(0, -1), fileContext, token => {
      full += token;
      this._view!.webview.postMessage({ type: 'token', token });
    });
    chat.history.push({ role: 'assistant', content: full });
    this.upsertChat(chat);
    this._view.webview.postMessage({ type: 'done' });
  }

  public async handleAnalyze() {
    if (!this._view) return;
    const info = getActiveFileInfo();
    if (!info) return;
    let chat = this.getCurrentChat() ?? this.newChat();
    this._view.webview.postMessage({ type: 'start', label: `Analyzing ${info.filename}…` });
    let full = '';
    await streamAnalysis(info.code, info.filename, token => {
      full += token;
      this._view!.webview.postMessage({ type: 'token', token });
    });
    chat.history.push({ role: 'assistant', content: full });
    this.upsertChat(chat);
    this._view.webview.postMessage({ type: 'done' });
  }

  public async sendMessage(text: string) {
    this._view?.show(true);
    await this.handleChat(text);
  }

  // ── HTML ──────────────────────────────────────────────────────
  private getHtml(webview: vscode.Webview): string {
    const logoUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'silologonobg.svg')
    );
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Silo Code</title>
<style>
:root{
  --bg:#080705; --surface:#131108; --surface2:#1e1b12;
  --gold:#C4A165; --gold-dim:#7a6035;
  --text:#F0EBE0; --muted:#8a8070;
  --border:#2a2518; --radius:12px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--vscode-font-family),-apple-system,sans-serif;font-size:13px;height:100vh;display:flex;flex-direction:column;overflow:hidden}

/* ── HEADER ── */
#header{display:flex;align-items:center;justify-content:flex-end;padding:6px 8px;gap:2px;flex-shrink:0}
.hdr-btn{background:none;border:none;color:var(--muted);cursor:pointer;padding:5px;border-radius:7px;display:flex;align-items:center;justify-content:center;transition:color .2s,background .2s}
.hdr-btn:hover{color:var(--text);background:var(--surface2)}
.hdr-btn svg{width:16px;height:16px}

/* ── HISTORY PANEL ── */
#history-panel{display:none;flex-direction:column;flex:1;overflow:hidden}
#history-panel.open{display:flex}
#history-header{padding:10px 12px 6px;font-size:11px;color:var(--muted);font-weight:600;letter-spacing:.05em;text-transform:uppercase}
#history-list{flex:1;overflow-y:auto;padding:4px 6px;display:flex;flex-direction:column;gap:2px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.hist-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;transition:background .15s}
.hist-item:hover{background:var(--surface2)}
.hist-item.active{background:var(--surface2);border-left:2px solid var(--gold)}
.hist-info{flex:1;overflow:hidden}
.hist-title{font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hist-preview{font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.hist-del{opacity:0;background:none;border:none;color:var(--muted);cursor:pointer;padding:2px 4px;border-radius:4px;font-size:11px;transition:opacity .15s,color .15s;flex-shrink:0}
.hist-item:hover .hist-del{opacity:1}
.hist-del:hover{color:#c0392b}

/* ── CHAT AREA ── */
#chat-wrap{display:flex;flex-direction:column;flex:1;overflow:hidden}
#empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center}
#empty-state img{width:52px;height:52px;object-fit:contain;opacity:.85}
#messages{flex:1;overflow-y:auto;padding:10px 10px 4px;display:flex;flex-direction:column;gap:10px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
#messages::-webkit-scrollbar{width:3px}
#messages::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}

/* ── MESSAGES ── */
.msg{display:flex;flex-direction:column;gap:3px}
.msg-user{align-items:flex-end}
.msg-assistant{align-items:flex-start}
.bubble{padding:9px 13px;border-radius:var(--radius);line-height:1.65;white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.bubble-user{background:var(--surface2);border:1px solid var(--border);border-bottom-right-radius:4px;color:var(--text)}
.bubble-assistant{background:transparent;color:var(--text);padding-left:0;border-bottom-left-radius:4px}
.bubble-assistant.cursor::after{content:'▌';color:var(--gold);animation:blink 1s step-end infinite}
@keyframes blink{50%{opacity:0}}
.img-attached{max-width:160px;border-radius:8px;border:1px solid var(--border);margin-bottom:3px}

/* ── BOTTOM ── */
#bottom{padding:6px 8px 8px;display:flex;flex-direction:column;gap:5px;flex-shrink:0}
#file-badge{display:none;align-items:center;gap:4px;padding:3px 8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;cursor:pointer;width:fit-content;max-width:100%;transition:border-color .2s;font-size:11px;color:var(--muted)}
#file-badge:hover{border-color:var(--gold-dim)}
#file-badge.excluded{opacity:.4}
#file-badge svg{width:11px;height:11px;flex-shrink:0;color:var(--gold)}
#file-name-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
#file-x{font-size:10px;margin-left:2px;color:var(--gold-dim)}

/* Input box */
#input-box{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:9px 10px;display:flex;flex-direction:column;gap:7px;transition:border-color .2s}
#input-box:focus-within{border-color:var(--gold-dim)}
#img-preview-wrap{display:none;align-items:center;gap:6px}
#img-preview-wrap.show{display:flex}
#img-preview{height:44px;border-radius:6px;border:1px solid var(--border)}
#img-remove{background:none;border:none;color:var(--muted);cursor:pointer;font-size:13px;line-height:1;padding:0}
#input{background:transparent;border:none;outline:none;color:var(--text);font-family:inherit;font-size:12.5px;resize:none;line-height:1.55;min-height:18px;max-height:110px;overflow-y:auto;width:100%;scrollbar-width:thin}
#input::placeholder{color:var(--muted)}

/* Actions row */
.actions{display:flex;align-items:center;gap:3px}
.actions-right{margin-left:auto;display:flex;align-items:center;gap:3px}
.icon-btn{background:none;border:none;color:var(--muted);cursor:pointer;padding:4px 6px;border-radius:7px;display:flex;align-items:center;gap:4px;font-size:11px;transition:color .2s,background .2s;position:relative}
.icon-btn:hover{color:var(--text);background:var(--surface2)}
.icon-btn svg{width:14px;height:14px}
.icon-btn-label{font-size:10px}

/* Send button */
.send-btn{background:var(--gold);border:none;color:var(--bg);cursor:pointer;width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:opacity .2s,transform .1s;flex-shrink:0}
.send-btn:hover{opacity:.85}
.send-btn:active{transform:scale(.93)}
.send-btn:disabled{opacity:.25;cursor:default}
.send-btn svg{width:14px;height:14px}

/* ── DROPDOWNS ── */
.dropdown{position:fixed;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:4px;z-index:999;min-width:210px;box-shadow:0 8px 28px rgba(0,0,0,.65);opacity:0;transform:translateY(6px);transition:opacity .18s ease,transform .18s ease;pointer-events:none}
.dropdown.open{opacity:1;transform:translateY(0);pointer-events:all}
.di{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:7px;cursor:pointer;color:var(--text);font-size:12px;transition:background .12s}
.di:hover{background:var(--surface)}
.di.active{color:var(--gold)}
.di svg{width:15px;height:15px;flex-shrink:0;color:var(--muted)}
.di.active svg{color:var(--gold)}
.di-body{display:flex;flex-direction:column;flex:1}
.di-title{font-size:12px;font-weight:500}
.di-desc{font-size:10px;color:var(--muted);margin-top:1px}
.di-check{color:var(--gold);font-size:12px;margin-left:auto;flex-shrink:0}
.sep{height:1px;background:var(--border);margin:4px 0}
.model-tier{font-size:9px;color:var(--muted);margin-left:auto;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:1px 5px;flex-shrink:0}
</style>
</head>
<body>

<!-- Header -->
<div id="header">
  <button class="hdr-btn" id="hist-btn" title="Chat history">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
  </button>
  <button class="hdr-btn" id="new-chat-btn" title="New chat">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="10" y1="11" x2="14" y2="11"/></svg>
  </button>
</div>

<!-- History panel -->
<div id="history-panel">
  <div id="history-header">Recents</div>
  <div id="history-list"></div>
</div>

<!-- Chat wrap -->
<div id="chat-wrap">
  <div id="empty-state">
    <img src="${logoUri}" alt="Silo"/>
  </div>
  <div id="messages" style="display:none"></div>
</div>

<!-- Bottom -->
<div id="bottom">
  <div id="file-badge" title="Toggle file context">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    <span id="file-name-label"></span>
    <span id="file-x">✕</span>
  </div>

  <div id="input-box">
    <div id="img-preview-wrap">
      <img id="img-preview" src="" alt=""/>
      <button id="img-remove" title="Remove">✕</button>
    </div>
    <textarea id="input" rows="1" placeholder="Ask Silo…"></textarea>
    <div class="actions">
      <!-- + -->
      <button class="icon-btn" id="plus-btn" title="Add">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <div class="actions-right">
        <!-- Mode -->
        <button class="icon-btn" id="mode-btn" title="Mode">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
          <span class="icon-btn-label" id="mode-label">Ask</span>
        </button>
        <!-- Model -->
        <button class="icon-btn" id="model-btn" title="Model">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          <span class="icon-btn-label" id="model-label">32b</span>
        </button>
        <!-- Send -->
        <button class="send-btn" id="send-btn" disabled>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
        </button>
      </div>
    </div>
  </div>
</div>

<!-- + dropdown -->
<div class="dropdown" id="plus-menu">
  <div class="di" id="add-img-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
    <div class="di-body"><span class="di-title">Add image</span><span class="di-desc">Attach a screenshot or diagram</span></div>
  </div>
  <div class="di" id="add-file-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    <div class="di-body"><span class="di-title">Add file context</span><span class="di-desc">Include current file in prompt</span></div>
  </div>
  <div class="di" id="search-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <div class="di-body"><span class="di-title">Search web</span><span class="di-desc">Add search results as context</span></div>
  </div>
</div>

<!-- Mode dropdown -->
<div class="dropdown" id="mode-menu">
  <div class="di mode-item active" data-mode="ask" data-label="Ask">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>
    <div class="di-body"><span class="di-title">Ask before edits</span><span class="di-desc">Silo will ask for approval before each edit</span></div>
    <span class="di-check">✓</span>
  </div>
  <div class="di mode-item" data-mode="auto" data-label="Auto">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
    <div class="di-body"><span class="di-title">Edit automatically</span><span class="di-desc">Applies edits to selected text or file</span></div>
    <span class="di-check" style="display:none">✓</span>
  </div>
  <div class="di mode-item" data-mode="plan" data-label="Plan">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
    <div class="di-body"><span class="di-title">Plan mode</span><span class="di-desc">Explores code and presents a plan first</span></div>
    <span class="di-check" style="display:none">✓</span>
  </div>
  <div class="di mode-item" data-mode="bypass" data-label="Free">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
    <div class="di-body"><span class="di-title">Bypass permissions</span><span class="di-desc">Runs commands without asking</span></div>
    <span class="di-check" style="display:none">✓</span>
  </div>
</div>

<!-- Model dropdown -->
<div class="dropdown" id="model-menu"></div>

<input type="file" id="file-input" accept="image/*" style="display:none">

<script>
const vscode = acquireVsCodeApi();

// Elements
const input       = document.getElementById('input');
const sendBtn     = document.getElementById('send-btn');
const messages    = document.getElementById('messages');
const emptyState  = document.getElementById('empty-state');
const fileBadge   = document.getElementById('file-badge');
const fileLabel   = document.getElementById('file-name-label');
const fileX       = document.getElementById('file-x');
const imgWrap     = document.getElementById('img-preview-wrap');
const imgPrev     = document.getElementById('img-preview');
const modelLabel  = document.getElementById('model-label');
const modeLabel   = document.getElementById('mode-label');
const histPanel   = document.getElementById('history-panel');
const histList    = document.getElementById('history-list');
const chatWrap    = document.getElementById('chat-wrap');

let pendingImg = null;
let currentBubble = null;
let histOpen = false;

// ── Input auto-resize + send enable ──
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 110) + 'px';
  sendBtn.disabled = !input.value.trim() && !pendingImg;
});
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

// ── Image paste ──
input.addEventListener('paste', e => {
  for (const item of (e.clipboardData?.items ?? [])) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const r = new FileReader();
      r.onload = ev => setImg(ev.target.result);
      r.readAsDataURL(item.getAsFile());
      return;
    }
  }
});

function setImg(url) {
  pendingImg = url;
  imgPrev.src = url;
  imgWrap.classList.add('show');
  sendBtn.disabled = false;
}
document.getElementById('img-remove').onclick = () => {
  pendingImg = null;
  imgPrev.src = '';
  imgWrap.classList.remove('show');
  sendBtn.disabled = !input.value.trim();
};
document.getElementById('file-input').onchange = e => {
  const f = e.target.files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = ev => setImg(ev.target.result);
  r.readAsDataURL(f);
  e.target.value = '';
};

// ── Send ──
function send() {
  const text = input.value.trim();
  if (!text && !pendingImg) return;
  addUserMsg(text, pendingImg);
  vscode.postMessage({ type: 'chat', text, imageData: pendingImg });
  input.value = ''; input.style.height = 'auto'; sendBtn.disabled = true;
  pendingImg = null; imgPrev.src = ''; imgWrap.classList.remove('show');
}
sendBtn.onclick = send;

// ── Messages ──
function showChat() {
  emptyState.style.display = 'none';
  messages.style.display = 'flex';
}
function addUserMsg(text, imgData) {
  showChat();
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-user';
  if (imgData) {
    const img = document.createElement('img');
    img.src = imgData; img.className = 'img-attached';
    wrap.appendChild(img);
  }
  if (text) {
    const b = document.createElement('div');
    b.className = 'bubble bubble-user'; b.textContent = text;
    wrap.appendChild(b);
  }
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
}

window.addEventListener('message', e => {
  const msg = e.data;
  if (msg.type === 'start') {
    showChat();
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-assistant';
    const b = document.createElement('div');
    b.className = 'bubble bubble-assistant cursor';
    b.textContent = msg.label || '';
    wrap.appendChild(b);
    messages.appendChild(wrap);
    currentBubble = b;
    messages.scrollTop = messages.scrollHeight;
  } else if (msg.type === 'token' && currentBubble) {
    currentBubble.textContent += msg.token;
    messages.scrollTop = messages.scrollHeight;
  } else if (msg.type === 'done' && currentBubble) {
    currentBubble.classList.remove('cursor');
    currentBubble = null;
  } else if (msg.type === 'loadMessages') {
    messages.innerHTML = '';
    const hist = msg.history || [];
    if (hist.length === 0) {
      emptyState.style.display = 'flex';
      messages.style.display = 'none';
    } else {
      showChat();
      hist.forEach(m => {
        const wrap = document.createElement('div');
        wrap.className = 'msg msg-' + m.role;
        const b = document.createElement('div');
        b.className = 'bubble bubble-' + m.role;
        b.textContent = m.content;
        wrap.appendChild(b);
        messages.appendChild(wrap);
      });
      messages.scrollTop = messages.scrollHeight;
    }
    if (histOpen) toggleHistory();
  } else if (msg.type === 'fileState') {
    if (msg.filename) {
      fileBadge.style.display = 'flex';
      fileLabel.textContent = msg.filename;
      fileBadge.classList.toggle('excluded', !msg.included);
      fileX.textContent = msg.included ? '✕' : '+';
    } else {
      fileBadge.style.display = 'none';
    }
  } else if (msg.type === 'models') {
    buildModelMenu(msg.models, msg.current);
  } else if (msg.type === 'history') {
    buildHistoryList(msg.chats, msg.currentId);
  }
});

// ── File badge ──
fileBadge.onclick = () => vscode.postMessage({ type: 'toggleFile' });

// ── History ──
function toggleHistory() {
  histOpen = !histOpen;
  histPanel.classList.toggle('open', histOpen);
  chatWrap.style.display = histOpen ? 'none' : 'flex';
  if (histOpen) vscode.postMessage({ type: 'getHistory' });
}
document.getElementById('hist-btn').onclick = toggleHistory;
document.getElementById('new-chat-btn').onclick = () => {
  if (histOpen) toggleHistory();
  vscode.postMessage({ type: 'newChat' });
};

function buildHistoryList(chats, currentId) {
  histList.innerHTML = '';
  if (!chats.length) {
    histList.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:11px">No chats yet</div>';
    return;
  }
  chats.forEach(c => {
    const item = document.createElement('div');
    item.className = 'hist-item' + (c.id === currentId ? ' active' : '');
    item.innerHTML = \`
      <div class="hist-info">
        <div class="hist-title">\${esc(c.title)}</div>
        <div class="hist-preview">\${esc(c.preview)}</div>
      </div>
      <button class="hist-del" title="Delete" data-id="\${c.id}">✕</button>
    \`;
    item.querySelector('.hist-info').onclick = () => vscode.postMessage({ type: 'loadChat', id: c.id });
    item.querySelector('.hist-del').onclick = (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'deleteChat', id: c.id });
    };
    histList.appendChild(item);
  });
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Dropdowns ──
function closeAll() {
  document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
}
document.addEventListener('click', e => {
  if (!e.target.closest('.dropdown') && !e.target.closest('.icon-btn')) closeAll();
});
function openDropdown(menu, btn) {
  const isOpen = menu.classList.contains('open');
  closeAll();
  if (!isOpen) {
    const r = btn.getBoundingClientRect();
    menu.style.bottom = (window.innerHeight - r.top + 4) + 'px';
    menu.style.left = Math.max(4, r.left) + 'px';
    menu.classList.add('open');
  }
}

document.getElementById('plus-btn').onclick = e => { e.stopPropagation(); openDropdown(document.getElementById('plus-menu'), e.currentTarget); };
document.getElementById('add-img-btn').onclick = () => { closeAll(); document.getElementById('file-input').click(); };
document.getElementById('add-file-btn').onclick = () => { closeAll(); vscode.postMessage({ type: 'toggleFile' }); };
document.getElementById('search-btn').onclick = () => { closeAll(); };

document.getElementById('mode-btn').onclick = e => { e.stopPropagation(); openDropdown(document.getElementById('mode-menu'), e.currentTarget); };
document.querySelectorAll('.mode-item').forEach(item => {
  item.onclick = () => {
    document.querySelectorAll('.mode-item').forEach(i => {
      i.classList.remove('active');
      i.querySelector('.di-check').style.display = 'none';
    });
    item.classList.add('active');
    item.querySelector('.di-check').style.display = '';
    modeLabel.textContent = item.dataset.label;
    closeAll();
  };
});

document.getElementById('model-btn').onclick = e => { e.stopPropagation(); openDropdown(document.getElementById('model-menu'), e.currentTarget); };

function buildModelMenu(models, current) {
  const menu = document.getElementById('model-menu');
  menu.innerHTML = '';
  models.forEach(m => {
    const item = document.createElement('div');
    item.className = 'di' + (m.id === current ? ' active' : '');
    item.innerHTML = \`
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      <div class="di-body"><span class="di-title">\${esc(m.label)}</span></div>
      <span class="model-tier">\${esc(m.tier)}</span>
      <span class="di-check" style="\${m.id === current ? '' : 'display:none'}">✓</span>
    \`;
    item.onclick = () => {
      vscode.postMessage({ type: 'setModel', model: m.id });
      const tag = m.id.split(':')[1] || m.id;
      modelLabel.textContent = tag;
      closeAll();
    };
    menu.appendChild(item);
  });
  const tag = current.split(':')[1] || current;
  modelLabel.textContent = tag;
}

// ── Init ──
vscode.postMessage({ type: 'init' });
</script>
</body>
</html>`;
  }
}
