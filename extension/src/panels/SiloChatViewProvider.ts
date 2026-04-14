import * as vscode from 'vscode';
import { streamChat, streamAnalysis } from '../backend';
import { collectProjectContext, getActiveFileInfo } from '../contextCollector';

const MODELS = [
  { id: 'deepseek-r1:7b',   label: 'DeepSeek R1',     company: 'DeepSeek', logoFile: 'deepseek.svg', tier: 'Advanced' },
  { id: 'qwen2.5-coder:7b', label: 'Qwen 2.5 Coder',  company: 'Alibaba',  logoFile: 'qwen.svg',     tier: 'Balanced' },
  { id: 'llama3.2:3b',      label: 'Llama 3.2',       company: 'Meta',     logoFile: 'ollama.svg',   tier: 'Fast'     },
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
  private _currentModel = 'deepseek-r1:7b';
  // Sidebar-only state
  private _sidebarChatId: string | null = null;
  private _sidebarStreaming = false;
  private _sidebarAbort: AbortController | null = null;
  private _sidebarFileIncluded = true;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) {}

  // ── Sidebar post ──────────────────────────────────────────────
  private post(msg: any) {
    this._view?.webview.postMessage(msg);
  }

  // ── Standalone panel (new VS Code tab each time) ──────────────
  public createOrShow() {
    // Each call opens a brand-new VS Code editor tab
    let chatId: string | null = null;
    let isStreaming = false;
    let abortCtrl: AbortController | null = null;
    let fileIncluded = true;
    let turboMode = false;

    const panel = vscode.window.createWebviewPanel(
      'silo.chatView', 'Silo',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')] }
    );
    panel.iconPath = vscode.Uri.joinPath(this._extensionUri, 'media', 'silologonobg.svg');
    panel.webview.html = this.getHtml(panel.webview);

    const post = (msg: any) => panel.webview.postMessage(msg);

    const pushFile = () => {
      const editor = vscode.window.activeTextEditor;
      const filename = editor ? vscode.workspace.asRelativePath(editor.document.fileName) : null;
      post({ type: 'fileState', filename, included: fileIncluded });
    };

    const sendHist = () => {
      const chats = this.getChats().map(c => ({
        id: c.id, title: c.title, createdAt: c.createdAt,
        preview: c.history.find(m => m.role === 'user')?.content?.slice(0, 60) ?? 'Empty chat'
      }));
      post({ type: 'history', chats, currentId: chatId });
    };

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'init': {
          const c = this.makeChat();
          chatId = c.id;
          panel.title = c.title;
          post({ type: 'loadMessages', history: [], title: c.title, id: c.id });
          const modelsWithUris = MODELS.map(m => ({
            ...m,
            logoUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', m.logoFile)).toString()
          }));
          post({ type: 'models', models: modelsWithUris, current: this._currentModel });
          pushFile();
          break;
        }
        case 'chat': {
          if (isStreaming) return;
          let chat = this.getChats().find(c => c.id === chatId);
          if (!chat) { chat = this.makeChat(); chatId = chat.id; }
          const fileCtx = fileIncluded ? await collectProjectContext() : '';
          chat.history.push({ role: 'user', content: msg.text });
          if (chat.title === 'New chat' && msg.text) {
            chat.title = msg.text.slice(0, 40) + (msg.text.length > 40 ? '…' : '');
            panel.title = chat.title;
            post({ type: 'chatRenamed', id: chat.id, title: chat.title });
          }
          this.upsertChat(chat);
          isStreaming = true;
          abortCtrl = new AbortController();
          post({ type: 'start' });
          let full = ''; let stopped = false;
          try {
            await streamChat(msg.text, chat.history.slice(0, -1), fileCtx, t => { full += t; post({ type: 'token', token: t }); }, abortCtrl.signal);
          } catch (e: any) {
            if (e?.name === 'AbortError' || abortCtrl?.signal.aborted) { stopped = true; }
            else {
              post({ type: 'error', message: e?.message?.includes('fetch') || e?.code === 'ECONNREFUSED'
                ? 'Cannot connect to Silo backend. Is it running on port 8942?' : `Error: ${e?.message ?? 'Unknown error'}` });
            }
          }
          isStreaming = false; abortCtrl = null;
          if (stopped) post({ type: 'stopped' }); else if (full) post({ type: 'done' });
          if (full) { chat.history.push({ role: 'assistant', content: full }); this.upsertChat(chat); }
          break;
        }
        case 'stop': { if (abortCtrl) { abortCtrl.abort(); abortCtrl = null; } isStreaming = false; break; }
        case 'newChat': { this.createOrShow(); break; }
        case 'loadChat': {
          const c = this.getChats().find(c => c.id === msg.id);
          if (!c) break;
          chatId = c.id; panel.title = c.title;
          post({ type: 'loadMessages', history: c.history, title: c.title, id: c.id });
          break;
        }
        case 'deleteChat': {
          const chats = this.getChats().filter(c => c.id !== msg.id);
          this.saveChats(chats);
          if (chatId === msg.id) { chatId = chats[0]?.id ?? null; }
          sendHist();
          break;
        }
        case 'getHistory': sendHist(); break;
        case 'renameChat': {
          const chats = this.getChats();
          const c = chats.find(c => c.id === msg.id);
          if (!c) break;
          c.title = msg.title?.trim() || 'New chat';
          this.saveChats(chats);
          if (msg.id === chatId) panel.title = c.title;
          post({ type: 'chatRenamed', id: msg.id, title: c.title });
          break;
        }
        case 'toggleFile': { fileIncluded = !fileIncluded; pushFile(); break; }
        case 'setModel': { this._currentModel = msg.model; this.updateBackendModel(msg.model); break; }
        case 'setTurbo': { turboMode = msg.enabled; break; }
        case 'searchWeb': {
          const query = encodeURIComponent(msg.query || '');
          if (query) vscode.env.openExternal(vscode.Uri.parse(`https://duckduckgo.com/?q=${query}`));
          break;
        }
      }
    });

    vscode.window.onDidChangeActiveTextEditor(pushFile);
    panel.onDidDispose(() => {});
  }

  // ── Chat persistence ──────────────────────────────────────────
  private getChats(): Chat[] {
    return this._context.globalState.get<Chat[]>('silo.chats', []);
  }
  private saveChats(chats: Chat[]) {
    this._context.globalState.update('silo.chats', chats);
  }
  private upsertChat(chat: Chat) {
    const chats = this.getChats().filter(c => c.id !== chat.id);
    this.saveChats([chat, ...chats].slice(0, 50));
  }
  /** Create a new chat record (does NOT mutate sidebar state) */
  private makeChat(): Chat {
    const chat: Chat = { id: Date.now().toString(), title: 'New chat', history: [], createdAt: Date.now() };
    this.upsertChat(chat);
    return chat;
  }
  /** Create a new chat and set it as the sidebar's current chat */
  private newChat(): Chat {
    const chat = this.makeChat();
    this._sidebarChatId = chat.id;
    return chat;
  }
  private getCurrentChat(): Chat | null {
    if (!this._sidebarChatId) return null;
    return this.getChats().find(c => c.id === this._sidebarChatId) ?? null;
  }

  // ── Sidebar message handler ───────────────────────────────────
  private async _handleMessage(msg: any) {
    switch (msg.type) {
      case 'init':       this.onInit(); break;
      case 'chat':       await this.handleChat(msg.text, msg.imageData); break;
      case 'stop':       this.stopGeneration(); break;
      case 'newChat':    this.createOrShow(); break;
      case 'loadChat':   this.loadChat(msg.id); break;
      case 'deleteChat': this.deleteChat(msg.id); break;
      case 'getHistory': this.sendHistory(); break;
      case 'renameChat': this.renameChat(msg.id, msg.title); break;
      case 'toggleFile':
        this._sidebarFileIncluded = !this._sidebarFileIncluded;
        this.pushFileState(); break;
      case 'setModel':
        this._currentModel = msg.model;
        this.updateBackendModel(msg.model); break;
      case 'searchWeb': {
        const query = encodeURIComponent(msg.query || '');
        if (query) vscode.env.openExternal(vscode.Uri.parse(`https://duckduckgo.com/?q=${query}`));
        break;
      }
    }
  }

  // ── WebviewViewProvider (sidebar) ─────────────────────────────
  resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(msg => this._handleMessage(msg));
    vscode.window.onDidChangeActiveTextEditor(() => this.pushFileState());
  }

  private onInit() {
    const chats = this.getChats();
    if (chats.length > 0) {
      this._sidebarChatId = chats[0].id;
      this.post({ type: 'loadMessages', history: chats[0].history, title: chats[0].title, id: chats[0].id });
    } else {
      const c = this.newChat();
      this.post({ type: 'loadMessages', history: [], title: c.title, id: c.id });
    }
    const webview = this._view?.webview;
    if (!webview) return;
    const modelsWithUris = MODELS.map(m => ({
      ...m,
      logoUri: webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', m.logoFile)).toString()
    }));
    this.post({ type: 'models', models: modelsWithUris, current: this._currentModel });
    this.pushFileState();
  }

  private loadChat(id: string) {
    const chat = this.getChats().find(c => c.id === id);
    if (!chat) return;
    this._sidebarChatId = id;
    this.post({ type: 'loadMessages', history: chat.history, title: chat.title, id: chat.id });
  }

  private deleteChat(id: string) {
    const chats = this.getChats().filter(c => c.id !== id);
    this.saveChats(chats);
    if (this._sidebarChatId === id) {
      if (chats.length > 0) { this._sidebarChatId = chats[0].id; }
      else { this._sidebarChatId = this.newChat().id; }
    }
    this.sendHistory();
  }

  private renameChat(id: string, title: string) {
    const chats = this.getChats();
    const chat = chats.find(c => c.id === id);
    if (!chat) return;
    chat.title = title.trim() || 'New chat';
    this.saveChats(chats);
    this.post({ type: 'chatRenamed', id, title: chat.title });
  }

  private sendHistory() {
    const chats = this.getChats().map(c => ({
      id: c.id, title: c.title, createdAt: c.createdAt,
      preview: c.history.find(m => m.role === 'user')?.content?.slice(0, 60) ?? 'Empty chat'
    }));
    this.post({ type: 'history', chats, currentId: this._sidebarChatId });
  }

  private pushFileState() {
    const editor = vscode.window.activeTextEditor;
    const filename = editor ? vscode.workspace.asRelativePath(editor.document.fileName) : null;
    this.post({ type: 'fileState', filename, included: this._sidebarFileIncluded });
  }

  private async updateBackendModel(model: string) {
    const url = vscode.workspace.getConfiguration('silo').get('backendUrl', 'http://127.0.0.1:8942');
    try { await fetch(`${url}/model`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ model }) }); }
    catch { /* backend offline */ }
  }

  private stopGeneration() {
    if (this._sidebarAbort) { this._sidebarAbort.abort(); this._sidebarAbort = null; }
    this._sidebarStreaming = false;
  }

  public async handleChat(text: string, _imageData?: string) {
    if (!this._view || this._sidebarStreaming) return;
    let chat = this.getCurrentChat();
    if (!chat) { chat = this.newChat(); }

    const fileContext = this._sidebarFileIncluded ? await collectProjectContext() : '';
    chat.history.push({ role: 'user', content: text });
    if (chat.title === 'New chat' && text) {
      chat.title = text.slice(0, 40) + (text.length > 40 ? '…' : '');
      this.post({ type: 'chatRenamed', id: chat.id, title: chat.title });
    }
    this.upsertChat(chat);

    this._sidebarStreaming = true;
    this._sidebarAbort = new AbortController();
    this.post({ type: 'start' });

    let full = ''; let stopped = false;
    try {
      await streamChat(text, chat.history.slice(0, -1), fileContext, token => {
        full += token; this.post({ type: 'token', token });
      }, this._sidebarAbort.signal);
    } catch (e: any) {
      if (e?.name === 'AbortError' || this._sidebarAbort?.signal.aborted) { stopped = true; }
      else {
        this.post({ type: 'error', message: e?.message?.includes('fetch') || e?.code === 'ECONNREFUSED'
          ? 'Cannot connect to Silo backend. Is it running on port 8942?' : `Error: ${e?.message ?? 'Unknown error'}` });
      }
    }
    this._sidebarStreaming = false; this._sidebarAbort = null;
    if (stopped) this.post({ type: 'stopped' }); else if (full) this.post({ type: 'done' });
    if (full) { chat.history.push({ role: 'assistant', content: full }); this.upsertChat(chat); }
  }

  public async handleAnalyze() {
    if (!this._view) return;
    const info = getActiveFileInfo();
    if (!info) return;
    let chat = this.getCurrentChat() ?? this.newChat();
    this.post({ type: 'start', label: `Analyzing ${info.filename}…` });
    let full = '';
    await streamAnalysis(info.code, info.filename, token => {
      full += token;
      this.post({ type: 'token', token });
    });
    chat.history.push({ role: 'assistant', content: full });
    this.upsertChat(chat);
    this.post({ type: 'done' });
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
<title>Silo</title>
<style>
:root{
  --bg:#080705; --surface:#131108; --surface2:#1e1b12;
  --gold:#C4A165; --gold-dim:#7a6035;
  --text:#F0EBE0; --muted:#8a8070;
  --border:#2a2518; --radius:12px;
  --stop:#c0392b;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--vscode-font-family),-apple-system,sans-serif;font-size:13px;height:100vh;display:flex;flex-direction:column;overflow:hidden}

/* ── HEADER ── */
#header{display:flex;align-items:center;padding:6px 8px;gap:2px;flex-shrink:0}
#header-spacer{flex:1}
.hdr-btn{background:none;border:none;color:var(--muted);cursor:pointer;padding:5px;border-radius:7px;display:flex;align-items:center;justify-content:center;transition:color .2s,background .2s}
.hdr-btn:hover{color:var(--text);background:var(--surface2)}
.hdr-btn svg{width:16px;height:16px}
.hdr-btn.turbo-on{color:#f39c12;background:rgba(243,156,18,.12)}
.hdr-btn.turbo-on:hover{color:#e67e22;background:rgba(243,156,18,.2)}

/* ── CHAT TITLE BAR ── */
#title-bar{display:flex;align-items:center;padding:2px 8px 6px;flex-shrink:0;min-height:28px}
#title-group{display:flex;align-items:center;gap:3px;min-width:0;max-width:100%;overflow:hidden}
#chat-title{font-size:12px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75;flex-shrink:1;min-width:0}
#title-edit-input{flex:1;background:var(--surface2);border:1px solid var(--gold-dim);border-radius:6px;color:var(--text);font-size:12px;font-family:inherit;padding:2px 7px;outline:none;display:none;min-width:0}
.title-btn{background:none;border:1px solid transparent;color:var(--muted);cursor:pointer;padding:3px 4px;border-radius:5px;display:flex;align-items:center;flex-shrink:0;opacity:0;transition:opacity .15s,color .15s,border-color .15s,background .15s}
.title-btn svg{width:11px;height:11px}
#title-group:hover .title-btn{opacity:1}
.title-btn:hover{color:var(--gold);border-color:var(--border);background:var(--surface2)}

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
.hist-actions{display:flex;align-items:center;gap:1px;opacity:0;transition:opacity .15s;flex-shrink:0}
.hist-item:hover .hist-actions{opacity:1}
.hist-del,.hist-ren{background:none;border:none;color:var(--muted);cursor:pointer;padding:3px 5px;border-radius:4px;font-size:11px;transition:color .15s;display:flex;align-items:center}
.hist-del:hover{color:#c0392b}
.hist-ren:hover{color:var(--gold)}
.hist-ren svg{width:11px;height:11px}

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
.msg-stopped{font-size:11px;color:var(--muted);font-style:italic;padding:4px 0;display:flex;align-items:center;gap:5px}
.msg-stopped::before{content:'';display:inline-block;width:8px;height:8px;border-radius:2px;background:var(--stop);flex-shrink:0}
/* Code blocks */
.code-block{position:relative;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin:4px 0;overflow:hidden}
.code-block pre{padding:10px 12px;overflow-x:auto;font-family:var(--vscode-editor-font-family),monospace;font-size:11.5px;line-height:1.5;color:var(--text);white-space:pre;margin:0}
.code-lang{font-size:10px;color:var(--muted);padding:4px 12px 0;font-family:monospace}
.copy-btn{position:absolute;top:4px;right:6px;background:var(--surface);border:1px solid var(--border);border-radius:5px;color:var(--muted);cursor:pointer;font-size:10px;padding:2px 7px;transition:color .15s,border-color .15s}
.copy-btn:hover{color:var(--gold);border-color:var(--gold-dim)}

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
#img-preview-wrap{display:none;align-items:center;gap:6px;flex-wrap:wrap}
#img-preview-wrap.show{display:flex}
.img-thumb-wrap{position:relative;flex-shrink:0}
.img-thumb{height:44px;width:44px;object-fit:cover;border-radius:6px;border:1px solid var(--border)}
.img-thumb-del{position:absolute;top:-4px;right:-4px;background:var(--surface2);border:1px solid var(--border);border-radius:50%;width:14px;height:14px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted);font-size:9px;line-height:1;transition:color .15s}
.img-thumb-del:hover{color:#c0392b}
#input{background:transparent;border:none;outline:none;color:var(--text);font-family:inherit;font-size:12.5px;resize:none;line-height:1.55;min-height:18px;max-height:110px;overflow-y:auto;width:100%;scrollbar-width:thin}
#input::placeholder{color:var(--muted)}
#input:disabled{opacity:.5;cursor:not-allowed}
#input.streaming{opacity:1;cursor:text}

/* Actions row */
.actions{display:flex;align-items:center;gap:3px}
.actions-right{margin-left:auto;display:flex;align-items:center;gap:3px}
.icon-btn{background:none;border:none;color:var(--muted);cursor:pointer;padding:4px 6px;border-radius:7px;display:flex;align-items:center;gap:4px;font-size:11px;transition:color .2s,background .2s;position:relative}
.icon-btn:hover{color:var(--text);background:var(--surface2)}
.icon-btn svg{width:14px;height:14px}
.icon-btn-label{font-size:10px}

/* Send/Stop button */
.send-btn{background:var(--gold);border:none;color:var(--bg);cursor:pointer;width:28px;height:28px;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:opacity .2s,transform .1s,background .2s;flex-shrink:0}
.send-btn:hover{opacity:.85}
.send-btn:active{transform:scale(.93)}
.send-btn:disabled{opacity:.25;cursor:default}
.send-btn svg{width:14px;height:14px}
.send-btn.stopping{background:var(--stop)}
.send-btn.stopping:disabled{opacity:1;cursor:pointer}

/* ── DROPDOWNS ── */
.dropdown{position:fixed;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:4px;z-index:999;width:min(240px,calc(100vw - 16px));box-shadow:0 8px 28px rgba(0,0,0,.65);opacity:0;transform:translateY(6px);transition:opacity .18s ease,transform .18s ease;pointer-events:none}
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
/* Company logo */
.co-logo{width:22px;height:22px;border-radius:5px;object-fit:contain;flex-shrink:0;background:#F0EBE0;padding:2px}
.model-tier{font-size:9px;color:var(--muted);margin-left:auto;background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:1px 5px;flex-shrink:0}
</style>
</head>
<body>

<!-- Header -->
<div id="header">
  <button class="hdr-btn" id="hist-btn" title="Chat history">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
  </button>
  <div id="header-spacer"></div>
  <button class="hdr-btn" id="turbo-btn" title="Turbo mode — max GPU/RAM performance">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
  </button>
  <button class="hdr-btn" id="new-chat-btn" title="New chat">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="10" y1="11" x2="14" y2="11"/></svg>
  </button>
</div>

<!-- Chat title bar -->
<div id="title-bar">
  <div id="title-group">
    <span id="chat-title">New chat</span>
    <button class="title-btn" id="rename-btn" title="Rename chat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>
    <input id="title-edit-input" type="text" maxlength="60" />
  </div>
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
    <div id="img-preview-wrap"></div>
    <textarea id="input" rows="1" placeholder="Ask Silo…"></textarea>
    <div class="actions">
      <button class="icon-btn" id="plus-btn" title="Add">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <div class="actions-right">
        <button class="icon-btn" id="mode-btn" title="Mode">
          <svg id="mode-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>
          <span class="icon-btn-label" id="mode-label">Ask</span>
        </button>
        <button class="icon-btn" id="model-btn" title="Model">
          <img id="model-btn-logo" class="co-logo" style="width:16px;height:16px;padding:1px" src="" alt=""/>
          <span class="icon-btn-label" id="model-label">Fast</span>
        </button>
        <button class="send-btn" id="send-btn" disabled>
          <svg id="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
          <svg id="stop-icon" viewBox="0 0 24 24" fill="currentColor" style="display:none"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>
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
  <div class="sep"></div>
  <div class="di" id="search-web-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <div class="di-body"><span class="di-title">Search online</span><span class="di-desc">Open query in browser</span></div>
  </div>
</div>

<!-- Mode dropdown -->
<div class="dropdown" id="mode-menu">
  <div class="di mode-item active" data-mode="ask" data-label="Ask">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>
    <div class="di-body"><span class="di-title">Ask before edits</span><span class="di-desc">Approves each edit before applying</span></div>
    <span class="di-check">✓</span>
  </div>
  <div class="di mode-item" data-mode="auto" data-label="Auto">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
    <div class="di-body"><span class="di-title">Edit automatically</span><span class="di-desc">Applies edits without asking</span></div>
    <span class="di-check" style="display:none">✓</span>
  </div>
  <div class="di mode-item" data-mode="plan" data-label="Plan">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
    <div class="di-body"><span class="di-title">Plan mode</span><span class="di-desc">Explores and presents a plan first</span></div>
    <span class="di-check" style="display:none">✓</span>
  </div>
</div>

<!-- Model dropdown -->
<div class="dropdown" id="model-menu"></div>

<input type="file" id="file-input" accept="image/*" style="display:none">

<script>
const vscode = acquireVsCodeApi();

// ── Elements ──
const input        = document.getElementById('input');
const sendBtn      = document.getElementById('send-btn');
const sendIcon     = document.getElementById('send-icon');
const stopIcon     = document.getElementById('stop-icon');
const messages     = document.getElementById('messages');
const emptyState   = document.getElementById('empty-state');
const fileBadge    = document.getElementById('file-badge');
const fileLabel    = document.getElementById('file-name-label');
const fileX        = document.getElementById('file-x');
const imgWrap      = document.getElementById('img-preview-wrap');
const modelLabel   = document.getElementById('model-label');
const modelBtnLogo = document.getElementById('model-btn-logo');
const modeLabel    = document.getElementById('mode-label');
const modeIcon     = document.getElementById('mode-icon');
const histPanel    = document.getElementById('history-panel');
const histList     = document.getElementById('history-list');
const chatWrap     = document.getElementById('chat-wrap');
const titleBar     = document.getElementById('title-bar');
const chatTitle    = document.getElementById('chat-title');
const titleInput   = document.getElementById('title-edit-input');
const renameBtn    = document.getElementById('rename-btn');

// ── State ──
let pendingImgs   = [];
let currentBubble = null;
let histOpen      = false;
let isStreaming   = false;
let currentChatId = null;
let editingId     = null;
let lastModels    = [];
let turboMode     = false;

// Mode SVG paths
const MODE_ICONS = {
  ask:  '<path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  auto: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  plan: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
};

// ── Helpers ──
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function scrollBottom() {
  messages.scrollTop = messages.scrollHeight;
}
function showChat() {
  emptyState.style.display = 'none';
  messages.style.display = 'flex';
}
function showEmpty() {
  emptyState.style.display = 'flex';
  messages.style.display = 'none';
}

// ── Input auto-resize ──
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 110) + 'px';
  if (!isStreaming) sendBtn.disabled = !input.value.trim() && !pendingImgs.length;
});

// Enter to send, Shift+Enter for newline
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!isStreaming && (input.value.trim() || pendingImgs.length)) send();
  }
});

// ── Image handling ──
input.addEventListener('paste', e => {
  for (const item of (e.clipboardData?.items ?? [])) {
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) readImageFile(file);
      return;
    }
  }
});

function readImageFile(file) {
  if (file.size > 10 * 1024 * 1024) { showError('Image too large (max 10 MB)'); return; }
  const r = new FileReader();
  r.onload = ev => { if (ev.target?.result) addImg(ev.target.result); };
  r.onerror = () => showError('Failed to read image');
  r.readAsDataURL(file);
}

function addImg(url) {
  pendingImgs.push(url);
  renderImgPreviews();
  if (!isStreaming) sendBtn.disabled = false;
}

function removeImg(idx) {
  pendingImgs.splice(idx, 1);
  renderImgPreviews();
  if (!isStreaming) sendBtn.disabled = !input.value.trim() && !pendingImgs.length;
}

function renderImgPreviews() {
  imgWrap.innerHTML = '';
  if (!pendingImgs.length) { imgWrap.classList.remove('show'); return; }
  imgWrap.classList.add('show');
  pendingImgs.forEach((url, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'img-thumb-wrap';
    const img = document.createElement('img');
    img.src = url; img.className = 'img-thumb';
    const del = document.createElement('button');
    del.className = 'img-thumb-del'; del.textContent = '✕';
    del.addEventListener('click', () => removeImg(i));
    wrap.appendChild(img); wrap.appendChild(del);
    imgWrap.appendChild(wrap);
  });
}

document.getElementById('file-input').addEventListener('change', e => {
  Array.from(e.target.files ?? []).forEach(readImageFile);
  e.target.value = '';
});
document.getElementById('file-input').multiple = true;

// ── Error display ──
function showError(msg) {
  const el = document.createElement('div');
  el.className = 'msg-stopped';
  el.style.color = '#e74c3c';
  el.textContent = msg;
  messages.appendChild(el);
  scrollBottom();
  showChat();
}

// ── Streaming state ──
function setStreaming(val) {
  isStreaming = val;
  if (val) {
    sendBtn.disabled = false;
    sendBtn.classList.add('stopping');
    sendIcon.style.display = 'none';
    stopIcon.style.display = '';
    sendBtn.title = 'Stop generation';
  } else {
    sendBtn.classList.remove('stopping');
    sendIcon.style.display = '';
    stopIcon.style.display = 'none';
    sendBtn.title = '';
    sendBtn.disabled = !input.value.trim() && !pendingImgs.length;
  }
}

// ── Send / Stop ──
function send() {
  if (isStreaming) return;
  const text = input.value.trim();
  if (!text && !pendingImgs.length) return;

  const imgs = pendingImgs.slice();
  addUserMsg(text, imgs);
  vscode.postMessage({ type: 'chat', text, imageData: imgs[0] ?? null });

  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;
  pendingImgs = [];
  renderImgPreviews();
}

sendBtn.addEventListener('click', () => {
  if (isStreaming) {
    // Immediately update UI — don't wait for round-trip
    isStreaming = false;
    setStreaming(false);
    if (currentBubble) {
      currentBubble.classList.remove('cursor');
      currentBubble = null;
    }
    const el = document.createElement('div');
    el.className = 'msg-stopped';
    el.textContent = 'Generation stopped';
    messages.appendChild(el);
    scrollBottom();
    vscode.postMessage({ type: 'stop' });
  } else {
    send();
  }
});

// ── Chat title / rename ──
function startRename() {
  if (!currentChatId) return;
  titleInput.value = chatTitle.textContent;
  chatTitle.style.display = 'none';
  titleInput.style.display = 'block';
  titleInput.focus();
  titleInput.select();
  editingId = currentChatId;
}

function commitRename() {
  if (!editingId) return;
  const newTitle = titleInput.value.trim();
  if (newTitle && newTitle !== chatTitle.textContent) {
    vscode.postMessage({ type: 'renameChat', id: editingId, title: newTitle });
    chatTitle.textContent = newTitle;
  }
  titleInput.style.display = 'none';
  chatTitle.style.display = '';
  editingId = null;
}

renameBtn.addEventListener('click', startRename);
titleInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
  if (e.key === 'Escape') {
    titleInput.style.display = 'none';
    chatTitle.style.display = '';
    editingId = null;
  }
});
titleInput.addEventListener('blur', () => {
  // Small delay so click on rename btn doesn't double-fire
  setTimeout(commitRename, 100);
});

// ── Messages ──
function addUserMsg(text, imgs) {
  showChat();
  const wrap = document.createElement('div');
  wrap.className = 'msg msg-user';
  const imgList = Array.isArray(imgs) ? imgs : (imgs ? [imgs] : []);
  imgList.forEach(imgData => {
    const img = document.createElement('img');
    img.src = imgData;
    img.className = 'img-attached';
    img.onerror = () => img.remove();
    wrap.appendChild(img);
  });
  if (text) {
    const b = document.createElement('div');
    b.className = 'bubble bubble-user';
    b.textContent = text;
    wrap.appendChild(b);
  }
  if (wrap.children.length) {
    messages.appendChild(wrap);
    scrollBottom();
  }
}

// ── Markdown renderer (code blocks + copy) ──
const FENCE = '\`\`\`';
const CODE_SPLIT = new RegExp('(' + FENCE + '[\\s\\S]*?' + FENCE + ')', 'g');
const CODE_MATCH = new RegExp('^' + FENCE + '(\\w*)\\n?([\\s\\S]*?)' + FENCE + '$');
function renderContent(el, text) {
  const parts = String(text ?? '').split(CODE_SPLIT);
  parts.forEach(part => {
    const codeMatch = part.match(CODE_MATCH);
    if (codeMatch) {
      const lang = codeMatch[1] || '';
      const code = codeMatch[2];
      const block = document.createElement('div');
      block.className = 'code-block';
      if (lang) {
        const langEl = document.createElement('div');
        langEl.className = 'code-lang';
        langEl.textContent = lang;
        block.appendChild(langEl);
      }
      const pre = document.createElement('pre');
      pre.textContent = code;
      block.appendChild(pre);
      const copyBtn = document.createElement('button');
      copyBtn.className = 'copy-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(code).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        }).catch(() => {
          copyBtn.textContent = 'Error';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        });
      });
      block.appendChild(copyBtn);
      el.appendChild(block);
    } else if (part) {
      const span = document.createElement('span');
      span.textContent = part;
      el.appendChild(span);
    }
  });
}

function renderHistory(hist) {
  messages.innerHTML = '';
  if (!hist?.length) { showEmpty(); return; }
  showChat();
  hist.forEach(m => {
    if (!['user','assistant'].includes(m.role)) return;
    const wrap = document.createElement('div');
    wrap.className = 'msg msg-' + m.role;
    const b = document.createElement('div');
    b.className = 'bubble bubble-' + m.role;
    if (m.role === 'assistant') {
      renderContent(b, m.content);
    } else {
      b.textContent = m.content ?? '';
    }
    wrap.appendChild(b);
    messages.appendChild(wrap);
  });
  scrollBottom();
}

// ── Message handler ──
window.addEventListener('message', e => {
  const msg = e.data;
  if (!msg?.type) return;

  switch (msg.type) {
    case 'start': {
      showChat();
      setStreaming(true);
      const wrap = document.createElement('div');
      wrap.className = 'msg msg-assistant';
      const b = document.createElement('div');
      b.className = 'bubble bubble-assistant cursor';
      if (msg.label) b.textContent = msg.label;
      wrap.appendChild(b);
      messages.appendChild(wrap);
      currentBubble = b;
      scrollBottom();
      break;
    }
    case 'token': {
      if (currentBubble) {
        currentBubble.textContent += msg.token ?? '';
        scrollBottom();
      }
      break;
    }
    case 'done': {
      if (currentBubble) {
        currentBubble.classList.remove('cursor');
        // Re-render with code block highlighting
        const raw = currentBubble.textContent ?? '';
        if (raw.includes(FENCE)) {
          currentBubble.textContent = '';
          renderContent(currentBubble, raw);
        }
        currentBubble = null;
      }
      setStreaming(false);
      break;
    }
    case 'stopped': {
      // UI already updated by click handler; just ensure state is correct
      if (currentBubble) {
        currentBubble.classList.remove('cursor');
        currentBubble = null;
      }
      if (isStreaming) {
        setStreaming(false);
        const el = document.createElement('div');
        el.className = 'msg-stopped';
        el.textContent = 'Generation stopped';
        messages.appendChild(el);
        scrollBottom();
      }
      break;
    }
    case 'error': {
      if (currentBubble) {
        currentBubble.classList.remove('cursor');
        currentBubble = null;
      }
      setStreaming(false);
      showError(msg.message || 'An error occurred');
      break;
    }
    case 'loadMessages': {
      currentChatId = msg.id ?? null;
      const title = msg.title || 'New chat';
      chatTitle.textContent = title;
      // If editing title for a different chat, cancel
      if (editingId && editingId !== currentChatId) {
        titleInput.style.display = 'none';
        chatTitle.style.display = '';
        editingId = null;
      }
      renderHistory(msg.history);
      if (histOpen && !msg.stayInHistory) {
        histOpen = false;
        histPanel.classList.remove('open');
        chatWrap.style.display = 'flex';
        titleBar.style.display = 'flex';
      }
      break;
    }
    case 'chatRenamed': {
      if (msg.id === currentChatId) chatTitle.textContent = msg.title ?? '';
      break;
    }
    case 'fileState': {
      if (msg.filename) {
        fileBadge.style.display = 'flex';
        fileLabel.textContent = msg.filename;
        fileBadge.classList.toggle('excluded', !msg.included);
        fileX.textContent = msg.included ? '✕' : '+';
      } else {
        fileBadge.style.display = 'none';
      }
      break;
    }
    case 'models': {
      lastModels = msg.models ?? [];
      buildModelMenu(lastModels, msg.current);
      break;
    }
    case 'history': {
      buildHistoryList(msg.chats ?? [], msg.currentId);
      break;
    }
  }
});

// ── File badge ──
fileBadge.addEventListener('click', () => vscode.postMessage({ type: 'toggleFile' }));

// ── Turbo mode ──
document.getElementById('turbo-btn').addEventListener('click', () => {
  turboMode = !turboMode;
  document.getElementById('turbo-btn').classList.toggle('turbo-on', turboMode);
  vscode.postMessage({ type: 'setTurbo', enabled: turboMode });
  // Brief visual feedback
  const btn = document.getElementById('turbo-btn');
  btn.title = turboMode ? 'Turbo ON — max GPU/RAM' : 'Turbo mode — max GPU/RAM performance';
});

// ── History ──
function toggleHistory() {
  histOpen = !histOpen;
  histPanel.classList.toggle('open', histOpen);
  chatWrap.style.display = histOpen ? 'none' : 'flex';
  titleBar.style.display = histOpen ? 'none' : 'flex';
  if (histOpen) vscode.postMessage({ type: 'getHistory' });
}

document.getElementById('hist-btn').addEventListener('click', toggleHistory);
document.getElementById('new-chat-btn').addEventListener('click', () => {
  if (isStreaming) return; // don't start new chat mid-stream
  if (histOpen) toggleHistory();
  vscode.postMessage({ type: 'newChat' });
});

function buildHistoryList(chats, currentId) {
  histList.innerHTML = '';
  if (!chats.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:12px;color:var(--muted);font-size:11px';
    empty.textContent = 'No chats yet';
    histList.appendChild(empty);
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
      <div class="hist-actions">
        <button class="hist-ren" title="Rename">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="hist-del" title="Delete">✕</button>
      </div>
    \`;
    item.querySelector('.hist-info').addEventListener('click', () => {
      histOpen = false;
      histPanel.classList.remove('open');
      chatWrap.style.display = 'flex';
      titleBar.style.display = 'flex';
      vscode.postMessage({ type: 'loadChat', id: c.id });
    });
    item.querySelector('.hist-ren').addEventListener('click', ev => {
      ev.stopPropagation();
      // Load chat then trigger rename
      histOpen = false;
      histPanel.classList.remove('open');
      chatWrap.style.display = 'flex';
      titleBar.style.display = 'flex';
      if (c.id !== currentChatId) {
        vscode.postMessage({ type: 'loadChat', id: c.id });
        setTimeout(startRename, 200);
      } else {
        startRename();
      }
    });
    item.querySelector('.hist-del').addEventListener('click', ev => {
      ev.stopPropagation();
      item.style.opacity = '0.4';
      item.style.pointerEvents = 'none';
      vscode.postMessage({ type: 'deleteChat', id: c.id });
      setTimeout(() => {
        item.remove();
        if (!histList.querySelector('.hist-item')) {
          const empty = document.createElement('div');
          empty.style.cssText = 'padding:12px;color:var(--muted);font-size:11px';
          empty.textContent = 'No chats yet';
          histList.appendChild(empty);
        }
      }, 200);
    });
    histList.appendChild(item);
  });
}

// ── Dropdowns ──
function closeAll() {
  document.querySelectorAll('.dropdown.open').forEach(d => d.classList.remove('open'));
}

document.addEventListener('click', e => {
  if (!e.target.closest('.dropdown') && !e.target.closest('.icon-btn')) closeAll();
});

// Close dropdowns on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAll();
});

function openDropdown(menu, btn) {
  const isOpen = menu.classList.contains('open');
  closeAll();
  if (!isOpen) {
    const r = btn.getBoundingClientRect();
    const menuH = menu.offsetHeight || 200;
    const spaceAbove = r.top;
    // Open above if not enough space below
    if (spaceAbove > menuH + 8) {
      menu.style.bottom = (window.innerHeight - r.top + 4) + 'px';
      menu.style.top = 'auto';
    } else {
      menu.style.top = (r.bottom + 4) + 'px';
      menu.style.bottom = 'auto';
    }
    menu.style.left = Math.max(4, Math.min(r.left, window.innerWidth - 230)) + 'px';
    menu.classList.add('open');
  }
}

document.getElementById('plus-btn').addEventListener('click', e => {
  e.stopPropagation();
  openDropdown(document.getElementById('plus-menu'), e.currentTarget);
});
document.getElementById('add-img-btn').addEventListener('click', () => {
  closeAll();
  document.getElementById('file-input').click();
});
document.getElementById('add-file-btn').addEventListener('click', () => {
  closeAll();
  vscode.postMessage({ type: 'toggleFile' });
});
document.getElementById('search-web-btn').addEventListener('click', () => {
  closeAll();
  const query = input.value.trim();
  vscode.postMessage({ type: 'searchWeb', query });
});

document.getElementById('mode-btn').addEventListener('click', e => {
  e.stopPropagation();
  openDropdown(document.getElementById('mode-menu'), e.currentTarget);
});
document.querySelectorAll('.mode-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.mode-item').forEach(i => {
      i.classList.remove('active');
      i.querySelector('.di-check').style.display = 'none';
    });
    item.classList.add('active');
    item.querySelector('.di-check').style.display = '';
    modeLabel.textContent = item.dataset.label;
    const modeKey = item.dataset.mode;
    if (MODE_ICONS[modeKey]) modeIcon.innerHTML = MODE_ICONS[modeKey];
    closeAll();
  });
});

document.getElementById('model-btn').addEventListener('click', e => {
  e.stopPropagation();
  openDropdown(document.getElementById('model-menu'), e.currentTarget);
});

function buildModelMenu(models, current) {
  const menu = document.getElementById('model-menu');
  menu.innerHTML = '';
  if (!models?.length) {
    menu.innerHTML = '<div style="padding:10px;color:var(--muted);font-size:11px">No models available</div>';
    return;
  }
  models.forEach(m => {
    const item = document.createElement('div');
    item.className = 'di' + (m.id === current ? ' active' : '');
    item.innerHTML = \`
      <img class="co-logo" src="\${esc(m.logoUri)}" alt="\${esc(m.company)}" onerror="this.style.display='none'"/>
      <div class="di-body">
        <span class="di-title">\${esc(m.label)}</span>
        <span class="di-desc">\${esc(m.company)}</span>
      </div>
      <span class="model-tier">\${esc(m.tier)}</span>
      <span class="di-check" style="\${m.id === current ? '' : 'display:none'}">✓</span>
    \`;
    item.addEventListener('click', () => {
      vscode.postMessage({ type: 'setModel', model: m.id });
      modelLabel.textContent = m.tier;
      modelBtnLogo.src = m.logoUri;
      // Update active states
      menu.querySelectorAll('.di').forEach(d => {
        d.classList.remove('active');
        d.querySelector('.di-check').style.display = 'none';
      });
      item.classList.add('active');
      item.querySelector('.di-check').style.display = '';
      closeAll();
    });
    menu.appendChild(item);
  });
  const cur = models.find(m => m.id === current);
  if (cur) {
    modelLabel.textContent = cur.tier;
    modelBtnLogo.src = cur.logoUri;
  }
}

// ── Init ──
vscode.postMessage({ type: 'init' });
</script>
</body>
</html>`;
  }
}
