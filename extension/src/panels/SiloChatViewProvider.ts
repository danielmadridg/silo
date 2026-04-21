import * as vscode from 'vscode';
import { streamChat, streamAnalysis, compactHistory, streamReview } from '../backend';
import { collectProjectContext, getActiveFileInfo } from '../contextCollector';

const MODELS = [
  { id: 'qwen3:14b',          label: 'Qwen 3 14B',          company: 'Alibaba', logoFile: 'qwen.svg',   tier: 'Advanced', kind: 'local' },
  { id: 'qwen2.5-coder:32b',  label: 'Qwen 2.5 Coder 32B',  company: 'Alibaba', logoFile: 'qwen.svg',   tier: 'Balanced', kind: 'local' },
  { id: 'llama3.1:8b',        label: 'Llama 3.1 8B',         company: 'Meta',    logoFile: 'ollama.svg', tier: 'Fast',     kind: 'local' },
];

interface CloudModel {
  id: string;           // unique local id (prefixed "cloud:")
  label: string;        // user-visible name
  provider: 'openai' | 'anthropic' | 'gemini';
  remoteModel: string;  // e.g. "gpt-4o", "claude-sonnet-4-5", "gemini-2.0-flash"
  keyRef: string;       // SecretStorage key name
}

interface Chat {
  id: string;
  title: string;
  history: { role: string; content: string }[];
  createdAt: number;
  workspacePath?: string;
}

const PROVIDER_META: Record<string, { logoFile: string; company: string }> = {
  openai:    { logoFile: 'openai.svg', company: 'OpenAI' },
  anthropic: { logoFile: 'claude.svg', company: 'Anthropic' },
  gemini:    { logoFile: 'gemini.svg', company: 'Google' },
};

export class SiloChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'silo.chatView';
  private _view?: vscode.WebviewView;
  private _currentModel = 'qwen3:14b';
  // Sidebar-only state
  private _sidebarChatId: string | null = null;
  private _sidebarDraft: Chat | null = null;   // in-memory chat not yet persisted
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
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')], retainContextWhenHidden: true }
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
      post({ type: 'history', chats, currentId: chatId, workspace: this.getWorkspaceName(), workspacePath: this.getWorkspaceRoot() });
    };

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'init': {
          const c = this.makeChat();
          chatId = c.id;
          panel.title = c.title;
          post({ type: 'loadMessages', history: [], title: c.title, id: c.id });
          const modelsWithUris = this.buildModelsForWebview(panel.webview);
          post({ type: 'models', models: modelsWithUris, current: this._currentModel });
          post({ type: 'workspace', name: this.getWorkspaceName(), path: this.getWorkspaceRoot() });
          pushFile();
          break;
        }
        case 'chat': {
          if (isStreaming) return;
          if (msg.turbo !== undefined) turboMode = msg.turbo;
          const mode = (msg.mode === 'ask' || msg.mode === 'plan' || msg.mode === 'auto') ? msg.mode : 'auto';
          let chat = this.getChats().find(c => c.id === chatId);
          if (!chat) { chat = this.makeChat(); chatId = chat.id; }
          const fileCtx = fileIncluded ? await collectProjectContext() : '';
          const diagnostics = this.collectDiagnostics();
          const ws = this.getWorkspaceRoot();
          const gitDiff = await this.collectGitDiff(ws);
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
          const cloudSel = await this.resolveSelectedModel();
          try {
            await streamChat(
              msg.text, chat.history.slice(0, -1), fileCtx,
              t => { full += t; post({ type: 'token', token: t }); },
              {
                signal: abortCtrl.signal,
                turbo: turboMode,
                workspace: ws,
                mode,
                diagnostics,
                gitDiff,
                provider: cloudSel.provider,
                remoteModel: cloudSel.remoteModel,
                apiKey: cloudSel.apiKey,
                onToolEvent: ev => post({ type: ev.type, tool: ev.tool, args: ev.args, result: ev.result, success: ev.success, todos: ev.todos })
              }
            );
          } catch (e: any) {
            if (e?.name === 'AbortError' || abortCtrl?.signal.aborted) { stopped = true; }
            else {
              post({ type: 'error', message: e?.message?.includes('fetch') || e?.code === 'ECONNREFUSED'
                ? 'Cannot connect to Silo backend. Is it running on port 8942?' : `Error: ${e?.message ?? 'Unknown error'}` });
            }
          }
          isStreaming = false; abortCtrl = null;
          if (stopped) post({ type: 'stopped' });
          else post({ type: 'done' }); // always unlock UI
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
        case 'setModel': {
          this._currentModel = msg.model;
          if (!String(msg.model).startsWith('cloud:')) this.updateBackendModel(msg.model);
          break;
        }
        case 'addCloudModel': {
          const provider = msg.provider;
          if (provider === 'openai' || provider === 'anthropic' || provider === 'gemini') {
            await this.addCloudModel(provider, msg.remoteModel || '', msg.label || '', msg.apiKey || '');
            post({ type: 'models', models: this.buildModelsForWebview(panel.webview), current: this._currentModel });
          }
          break;
        }
        case 'removeCloudModel': {
          await this.removeCloudModel(msg.id);
          post({ type: 'models', models: this.buildModelsForWebview(panel.webview), current: this._currentModel });
          break;
        }
        case 'updateCloudModel': {
          await this.updateCloudModel(msg.id, {
            provider: msg.provider,
            remoteModel: msg.remoteModel,
            label: msg.label,
            apiKey: msg.apiKey,
          });
          post({ type: 'models', models: this.buildModelsForWebview(panel.webview), current: this._currentModel });
          break;
        }
        case 'getCloudModel': {
          const detail = await this.getCloudModelDetail(msg.id);
          post({ type: 'cloudModelDetail', detail });
          break;
        }
        case 'setTurbo': { turboMode = msg.enabled; break; }
        case 'openFile': {
          let filePath: string = msg.path || '';
          if (filePath && !require('path').isAbsolute(filePath) && msg.workspace) {
            filePath = require('path').join(msg.workspace, filePath);
          }
          if (filePath) {
            const uri = vscode.Uri.file(filePath);
            vscode.workspace.openTextDocument(uri).then(doc =>
              vscode.window.showTextDocument(doc, { preview: false })
            ).then(undefined, () => {});
          }
          break;
        }
        case 'searchWeb': {
          const query = encodeURIComponent(msg.query || '');
          if (query) vscode.env.openExternal(vscode.Uri.parse(`https://duckduckgo.com/?q=${query}`));
          break;
        }
        case 'exportChat': {
          const c = this.getChats().find(c => c.id === chatId);
          if (c) await this.exportChatAsMarkdown(c);
          break;
        }
        case 'reviewChat': {
          await this.handleReviewPanel(msg.baseRef, post, chatId);
          break;
        }
      }
    });

    vscode.window.onDidChangeActiveTextEditor(pushFile);
    panel.onDidDispose(() => {});
  }

  // ── Workspace key (scopes history per project, like Claude Code) ─
  private getWorkspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.[0]?.uri.fsPath ?? '__global__';
  }
  private getWorkspaceName(): string {
    const folders = vscode.workspace.workspaceFolders;
    return folders?.[0]?.name ?? 'Global';
  }
  private getChatsKey(): string {
    return `silo.chats::${this.getWorkspaceRoot()}`;
  }

  // ── Chat persistence ──────────────────────────────────────────
  private getChats(): Chat[] {
    const key = this.getChatsKey();
    const chats = this._context.globalState.get<Chat[]>(key, []);
    // One-time migration: import chats from old global key on first open
    if (chats.length === 0) {
      const legacy = this._context.globalState.get<Chat[]>('silo.chats', []);
      if (legacy.length > 0) {
        this._context.globalState.update(key, legacy);
        return legacy;
      }
    }
    return chats;
  }
  private saveChats(chats: Chat[]) {
    this._context.globalState.update(this.getChatsKey(), chats);
  }
  private upsertChat(chat: Chat) {
    // Skip persistence for empty chats — history must have at least one message.
    if (!chat.history || chat.history.length === 0) return;
    const chats = this.getChats().filter(c => c.id !== chat.id);
    this.saveChats([chat, ...chats].slice(0, 50));
  }
  /** Create a new chat record (in-memory only; persists on first message) */
  private makeChat(): Chat {
    return {
      id: Date.now().toString(),
      title: 'New chat',
      history: [],
      createdAt: Date.now(),
      workspacePath: this.getWorkspaceRoot()
    };
  }
  /** Create a new chat and set it as the sidebar's current chat */
  private newChat(): Chat {
    const chat = this.makeChat();
    this._sidebarChatId = chat.id;
    this._sidebarDraft = chat;
    return chat;
  }
  private getCurrentChat(): Chat | null {
    if (!this._sidebarChatId) return null;
    const saved = this.getChats().find(c => c.id === this._sidebarChatId);
    if (saved) { this._sidebarDraft = null; return saved; }
    if (this._sidebarDraft && this._sidebarDraft.id === this._sidebarChatId) return this._sidebarDraft;
    return null;
  }

  // ── Sidebar message handler ───────────────────────────────────
  private async _handleMessage(msg: any) {
    switch (msg.type) {
      case 'init':       this.onInit(); break;
      case 'chat':       await this.handleChat(msg.text, msg.imageData, (msg.mode === 'ask' || msg.mode === 'plan' || msg.mode === 'auto') ? msg.mode : 'auto'); break;
      case 'compact':    await this.compactCurrentChat(); break;
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
        if (!String(msg.model).startsWith('cloud:')) this.updateBackendModel(msg.model);
        break;
      case 'addCloudModel': {
        const provider = msg.provider;
        if (provider === 'openai' || provider === 'anthropic' || provider === 'gemini') {
          await this.addCloudModel(provider, msg.remoteModel || '', msg.label || '', msg.apiKey || '');
          if (this._view) this.post({ type: 'models', models: this.buildModelsForWebview(this._view.webview), current: this._currentModel });
        }
        break;
      }
      case 'removeCloudModel':
        await this.removeCloudModel(msg.id);
        if (this._view) this.post({ type: 'models', models: this.buildModelsForWebview(this._view.webview), current: this._currentModel });
        break;
      case 'updateCloudModel':
        await this.updateCloudModel(msg.id, {
          provider: msg.provider,
          remoteModel: msg.remoteModel,
          label: msg.label,
          apiKey: msg.apiKey,
        });
        if (this._view) this.post({ type: 'models', models: this.buildModelsForWebview(this._view.webview), current: this._currentModel });
        break;
      case 'getCloudModel': {
        const detail = await this.getCloudModelDetail(msg.id);
        this.post({ type: 'cloudModelDetail', detail });
        break;
      }
      case 'setTurbo': break; // turbo is sent per-message in 'chat'
      case 'openFile': {
        let fp: string = msg.path || '';
        if (fp && !require('path').isAbsolute(fp) && msg.workspace) {
          fp = require('path').join(msg.workspace, fp);
        }
        if (fp) {
          const uri = vscode.Uri.file(fp);
          vscode.workspace.openTextDocument(uri).then(doc =>
            vscode.window.showTextDocument(doc, { preview: false })
          ).then(undefined, () => {});
        }
        break;
      }
      case 'searchWeb': {
        const query = encodeURIComponent(msg.query || '');
        if (query) vscode.env.openExternal(vscode.Uri.parse(`https://duckduckgo.com/?q=${query}`));
        break;
      }
      case 'exportChat': {
        const chat = this.getCurrentChat();
        if (chat) await this.exportChatAsMarkdown(chat);
        break;
      }
      case 'reviewChat': {
        await this.handleReview(msg.baseRef);
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
    const webview = this._view?.webview;
    const chats = this.getChats();
    if (chats.length > 0) {
      this._sidebarChatId = chats[0].id;
      this.post({ type: 'loadMessages', history: chats[0].history, title: chats[0].title, id: chats[0].id });
    } else {
      const c = this.newChat();
      this.post({ type: 'loadMessages', history: [], title: c.title, id: c.id });
    }
    if (webview) {
      const modelsWithUris = this.buildModelsForWebview(webview);
      this.post({ type: 'models', models: modelsWithUris, current: this._currentModel });
    }
    this.post({ type: 'workspace', name: this.getWorkspaceName(), path: this.getWorkspaceRoot() });
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
    this.post({ type: 'history', chats, currentId: this._sidebarChatId, workspace: this.getWorkspaceName(), workspacePath: this.getWorkspaceRoot() });
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

  // ── Cloud model registry ──────────────────────────────────────
  private static CLOUD_KEY = 'silo.cloudModels';

  private getCloudModels(): CloudModel[] {
    return this._context.globalState.get<CloudModel[]>(SiloChatViewProvider.CLOUD_KEY, []);
  }
  private saveCloudModels(list: CloudModel[]) {
    this._context.globalState.update(SiloChatViewProvider.CLOUD_KEY, list);
  }
  private async addCloudModel(provider: 'openai' | 'anthropic' | 'gemini', remoteModel: string, label: string, apiKey: string): Promise<CloudModel> {
    const id = `cloud:${provider}:${Date.now()}`;
    const keyRef = `silo.apiKey.${id}`;
    await this._context.secrets.store(keyRef, apiKey);
    const model: CloudModel = { id, label: label || remoteModel, provider, remoteModel, keyRef };
    const list = this.getCloudModels();
    list.push(model);
    this.saveCloudModels(list);
    return model;
  }
  private async removeCloudModel(id: string) {
    const list = this.getCloudModels();
    const m = list.find(x => x.id === id);
    if (m) { try { await this._context.secrets.delete(m.keyRef); } catch {} }
    this.saveCloudModels(list.filter(x => x.id !== id));
    if (this._currentModel === id) this._currentModel = 'qwen3:14b';
  }
  private async updateCloudModel(id: string, patch: { provider?: 'openai' | 'anthropic' | 'gemini'; remoteModel?: string; label?: string; apiKey?: string }) {
    const list = this.getCloudModels();
    const m = list.find(x => x.id === id);
    if (!m) return;
    if (patch.provider) m.provider = patch.provider;
    if (patch.remoteModel !== undefined) m.remoteModel = patch.remoteModel || m.remoteModel;
    if (patch.label !== undefined) m.label = patch.label || m.remoteModel;
    if (patch.apiKey) {
      try { await this._context.secrets.store(m.keyRef, patch.apiKey); } catch {}
    }
    this.saveCloudModels(list);
  }
  private async getCloudModelDetail(id: string): Promise<any | null> {
    const m = this.getCloudModels().find(x => x.id === id);
    if (!m) return null;
    const apiKey = (await this._context.secrets.get(m.keyRef)) || '';
    return { id: m.id, provider: m.provider, remoteModel: m.remoteModel, label: m.label, apiKey };
  }
  private async resolveSelectedModel(): Promise<{ provider: string; remoteModel: string; apiKey: string }> {
    const cm = this.getCloudModels().find(m => m.id === this._currentModel);
    if (!cm) return { provider: '', remoteModel: '', apiKey: '' };
    const apiKey = (await this._context.secrets.get(cm.keyRef)) || '';
    return { provider: cm.provider, remoteModel: cm.remoteModel, apiKey };
  }
  private buildModelsForWebview(webview: vscode.Webview) {
    const toUri = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', file)).toString();
    const local = MODELS.map(m => ({
      id: m.id, label: m.label, company: m.company, tier: m.tier, kind: 'local',
      logoUri: toUri(m.logoFile),
    }));
    const cloud = this.getCloudModels().map(m => {
      const meta = PROVIDER_META[m.provider];
      return {
        id: m.id, label: m.label, company: meta?.company ?? m.provider, tier: m.remoteModel, kind: 'cloud',
        provider: m.provider, remoteModel: m.remoteModel,
        logoUri: toUri(meta?.logoFile ?? 'ollama.svg'),
      };
    });
    return [...local, ...cloud];
  }

  // ── IDE signal collectors ─────────────────────────────────────
  private collectDiagnostics(): string {
    const out: string[] = [];
    const all = vscode.languages.getDiagnostics();
    const sevName = (s: vscode.DiagnosticSeverity) =>
      s === vscode.DiagnosticSeverity.Error ? 'ERROR'
      : s === vscode.DiagnosticSeverity.Warning ? 'WARN'
      : s === vscode.DiagnosticSeverity.Information ? 'INFO' : 'HINT';
    for (const [uri, diags] of all) {
      const rel = vscode.workspace.asRelativePath(uri.fsPath);
      for (const d of diags) {
        if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
        out.push(`${rel}:${d.range.start.line + 1}:${d.range.start.character + 1}  ${sevName(d.severity)}  ${d.message.split('\n')[0]}`);
        if (out.length >= 60) break;
      }
      if (out.length >= 60) break;
    }
    return out.join('\n');
  }

  private async collectGitDiff(cwd: string): Promise<string> {
    if (!cwd || cwd === '__global__') return '';
    return new Promise<string>((resolve) => {
      try {
        const { exec } = require('child_process');
        exec('git diff --no-color HEAD', { cwd, maxBuffer: 1024 * 1024 }, (err: any, stdout: string) => {
          if (err) resolve('');
          else resolve((stdout || '').slice(0, 6000));
        });
      } catch { resolve(''); }
    });
  }

  private async compactCurrentChat() {
    const chat = this.getCurrentChat();
    if (!chat || !chat.history.length) return;
    try {
      const summary = await compactHistory(chat.history);
      if (!summary) return;
      chat.history = [{ role: 'system', content: `## Prior conversation (compacted)\n\n${summary}` }];
      this.upsertChat(chat);
      this.post({ type: 'loadMessages', history: chat.history, title: chat.title, id: chat.id });
    } catch { /* backend offline */ }
  }

  private stopGeneration() {
    if (this._sidebarAbort) { this._sidebarAbort.abort(); this._sidebarAbort = null; }
    this._sidebarStreaming = false;
  }

  public async handleChat(text: string, _imageData?: string, mode: 'ask' | 'plan' | 'auto' = 'auto') {
    if (!this._view || this._sidebarStreaming) return;
    let chat = this.getCurrentChat();
    if (!chat) { chat = this.newChat(); }

    const fileContext = this._sidebarFileIncluded ? await collectProjectContext() : '';
    const ws = this.getWorkspaceRoot();
    const diagnostics = this.collectDiagnostics();
    const gitDiff = await this.collectGitDiff(ws);
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
    const cloudSel = await this.resolveSelectedModel();
    try {
      await streamChat(
        text, chat.history.slice(0, -1), fileContext,
        token => { full += token; this.post({ type: 'token', token }); },
        {
          signal: this._sidebarAbort.signal,
          turbo: false,
          workspace: ws,
          mode,
          diagnostics,
          gitDiff,
          provider: cloudSel.provider,
          remoteModel: cloudSel.remoteModel,
          apiKey: cloudSel.apiKey,
          onToolEvent: ev => {
            this.post({ type: ev.type, tool: ev.tool, args: ev.args, result: ev.result, success: ev.success, todos: ev.todos, tokens: ev.tokens });
          }
        }
      );
    } catch (e: any) {
      if (e?.name === 'AbortError' || this._sidebarAbort?.signal.aborted) { stopped = true; }
      else {
        this.post({ type: 'error', message: e?.message?.includes('fetch') || e?.code === 'ECONNREFUSED'
          ? 'Cannot connect to Silo backend. Is it running on port 8942?' : `Error: ${e?.message ?? 'Unknown error'}` });
      }
    }
    this._sidebarStreaming = false; this._sidebarAbort = null;
    if (stopped) this.post({ type: 'stopped' });
    else this.post({ type: 'done' }); // always unlock UI
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

  /** Export current chat as markdown in a new editor tab */
  public async exportChatAsMarkdown(chat: { title: string; history: { role: string; content: string }[] }) {
    const lines: string[] = [`# ${chat.title}`, '', `_Exported from Silo — ${new Date().toLocaleString()}_`, ''];
    for (const m of chat.history) {
      if (m.role === 'user') {
        lines.push(`**You:** ${m.content}`, '');
      } else if (m.role === 'assistant') {
        lines.push(`**Silo:**`, '', m.content, '');
      }
    }
    const content = lines.join('\n');
    const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /** Stream a PR/diff review into the sidebar */
  public async handleReview(baseRef?: string) {
    if (!this._view || this._sidebarStreaming) return;
    const ws = this.getWorkspaceRoot();
    let chat = this.getCurrentChat();
    if (!chat) { chat = this.newChat(); }

    this._sidebarStreaming = true;
    this._sidebarAbort = new AbortController();
    this.post({ type: 'start' });

    let full = '';
    const cloudSel = await this.resolveSelectedModel();
    try {
      await streamReview(
        ws,
        baseRef || 'HEAD~1',
        token => { full += token; this.post({ type: 'token', token }); },
        {
          provider: cloudSel.provider,
          remoteModel: cloudSel.remoteModel,
          apiKey: cloudSel.apiKey,
          signal: this._sidebarAbort.signal,
        }
      );
    } catch (e: any) {
      if (!(e?.name === 'AbortError' || this._sidebarAbort?.signal.aborted)) {
        this.post({ type: 'error', message: `Review failed: ${e?.message ?? 'Unknown error'}` });
      }
    }
    this._sidebarStreaming = false; this._sidebarAbort = null;
    this.post({ type: 'done' });
    if (full) { chat.history.push({ role: 'assistant', content: full }); this.upsertChat(chat); }
  }

  /** Panel variant of review (needs its own post function) */
  public async handleReviewPanel(baseRef: string | undefined, post: (msg: any) => void, chatId: string | null) {
    const ws = this.getWorkspaceRoot();
    post({ type: 'start' });
    let full = '';
    const cloudSel = await this.resolveSelectedModel();
    try {
      await streamReview(
        ws, baseRef || 'HEAD~1',
        token => { full += token; post({ type: 'token', token }); },
        { provider: cloudSel.provider, remoteModel: cloudSel.remoteModel, apiKey: cloudSel.apiKey }
      );
    } catch (e: any) {
      post({ type: 'error', message: `Review failed: ${e?.message ?? 'Unknown error'}` });
    }
    post({ type: 'done' });
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
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0a0806; --bg-deep:#050403;
  --surface:#15110a; --surface2:#1f1a11; --surface3:#2a2416;
  --border:#2a2316; --border-bright:#3d3420;
  --gold:#C4A165; --gold-bright:#D9B97A; --gold-dim:#8a6f3f;
  --gold-glow:rgba(196,161,101,.18);
  --text:#F5F0E3; --muted:#9a907c; --dim:#6d6555;
  --stop:#c0392b; --success:#27ae60;
  --radius:14px; --radius-sm:8px;
  --serif:'Instrument Serif',Georgia,serif;
  --sans:'Geist',-apple-system,BlinkMacSystemFont,sans-serif;
  --mono:'JetBrains Mono',ui-monospace,Consolas,monospace;
  --ease:cubic-bezier(.22,.61,.36,1);
  --ease-out:cubic-bezier(.16,1,.3,1);
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:13px;font-weight:400;letter-spacing:-.005em;height:100vh;display:flex;flex-direction:column;overflow:hidden;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body::before{content:'';position:fixed;inset:0;pointer-events:none;background:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(196,161,101,.06),transparent 70%);z-index:0}
#header,#title-bar,#chat-wrap,#bottom{position:relative;z-index:1}

/* ── HEADER ── */
#header{display:flex;align-items:center;padding:10px 12px 6px;gap:2px;flex-shrink:0}
#header-spacer{flex:1}
.hdr-btn{background:transparent;border:none;color:var(--muted);cursor:pointer;padding:6px;border-radius:9px;display:flex;align-items:center;justify-content:center;transition:color .2s var(--ease),background .2s var(--ease),transform .15s var(--ease)}
.hdr-btn:hover{color:var(--text);background:var(--surface2)}
.hdr-btn:active{transform:scale(.94)}
.hdr-btn svg{width:16px;height:16px}
#turbo-btn{padding:5px 6px;border-radius:9px;transition:color .25s var(--ease),background .25s var(--ease),box-shadow .25s var(--ease)}
#turbo-btn svg{width:13px;height:13px}
#turbo-btn.turbo-on{color:#f5b041;background:rgba(245,176,65,.08);box-shadow:0 0 0 1px rgba(245,176,65,.3),0 0 16px rgba(245,176,65,.12)}
#turbo-btn.turbo-on:hover{color:#f39c12;background:rgba(245,176,65,.14)}

/* ── CHAT TITLE BAR ── */
#title-bar{display:flex;align-items:center;padding:0 14px 8px;flex-shrink:0;min-height:26px}
#title-group{display:flex;align-items:center;gap:4px;min-width:0;max-width:100%;overflow:hidden}
#chat-title{font-family:var(--serif);font-style:italic;font-size:15px;font-weight:400;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.72;flex-shrink:1;min-width:0;letter-spacing:.01em}
#title-edit-input{flex:1;background:var(--surface2);border:1px solid var(--gold-dim);border-radius:7px;color:var(--text);font-family:var(--serif);font-style:italic;font-size:15px;padding:3px 9px;outline:none;display:none;min-width:0;transition:border-color .2s var(--ease),box-shadow .2s var(--ease)}
#title-edit-input:focus{border-color:var(--gold);box-shadow:0 0 0 3px var(--gold-glow)}
.title-btn{background:none;border:1px solid transparent;color:var(--muted);cursor:pointer;padding:4px 5px;border-radius:6px;display:flex;align-items:center;flex-shrink:0;opacity:0;transform:translateX(-4px);transition:opacity .25s var(--ease),transform .25s var(--ease),color .15s,border-color .15s,background .15s}
.title-btn svg{width:11px;height:11px}
#title-group:hover .title-btn{opacity:1;transform:translateX(0)}
.title-btn:hover{color:var(--gold);border-color:var(--border-bright);background:var(--surface2)}

/* ── HISTORY PANEL ── */
#history-panel{display:none;flex-direction:column;flex:1;overflow:hidden;animation:fadeIn .25s var(--ease-out)}
#history-panel.open{display:flex}
#history-header{padding:6px 16px 10px;display:flex;flex-direction:column;gap:4px;border-bottom:1px solid var(--border)}
#history-header-title{font-family:var(--sans);font-size:10px;color:var(--muted);font-weight:600;letter-spacing:.16em;text-transform:uppercase}
#history-workspace{font-size:10.5px;color:var(--gold-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;font-family:var(--mono)}
#history-list{flex:1;overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:2px;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.hist-item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer;transition:background .18s var(--ease),transform .15s var(--ease);position:relative}
.hist-item:hover{background:var(--surface2)}
.hist-item:active{transform:scale(.99)}
.hist-item.active{background:linear-gradient(90deg,rgba(196,161,101,.09),transparent)}
.hist-item.active::before{content:'';position:absolute;left:0;top:8px;bottom:8px;width:2px;border-radius:2px;background:var(--gold);box-shadow:0 0 8px var(--gold-glow)}
.hist-info{flex:1;overflow:hidden}
.hist-title{font-size:12.5px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:500;letter-spacing:-.005em}
.hist-preview{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px;font-weight:300}
.hist-actions{display:flex;align-items:center;gap:2px;opacity:0;transition:opacity .18s var(--ease);flex-shrink:0}
.hist-item:hover .hist-actions{opacity:1}
.hist-del,.hist-ren{background:none;border:none;color:var(--muted);cursor:pointer;padding:4px 6px;border-radius:5px;font-size:11px;transition:color .15s,background .15s;display:flex;align-items:center}
.hist-del:hover{color:#ff6b6b;background:rgba(255,107,107,.1)}
.hist-ren:hover{color:var(--gold);background:var(--surface3)}
.hist-ren svg{width:11px;height:11px}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}

/* ── CHAT AREA ── */
#chat-wrap{display:flex;flex-direction:column;flex:1;overflow:hidden}
#empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 28px;gap:22px;animation:emptyIn .7s var(--ease-out)}
#empty-state img{width:48px;height:48px;object-fit:contain;opacity:.95;filter:drop-shadow(0 4px 18px var(--gold-glow));animation:emptyLogo 1s var(--ease-out) .1s backwards}
#empty-brand{font-family:var(--serif);font-style:italic;font-size:38px;font-weight:400;color:var(--text);letter-spacing:-.01em;line-height:1;animation:emptyLogo 1s var(--ease-out) .2s backwards}
#empty-brand em{color:var(--gold);font-style:italic}
#empty-subtitle{font-family:var(--sans);font-size:12px;color:var(--muted);font-weight:300;letter-spacing:.02em;text-align:center;max-width:280px;line-height:1.55;animation:emptyLogo 1s var(--ease-out) .3s backwards}
#empty-divider{width:40px;height:1px;background:linear-gradient(90deg,transparent,var(--gold-dim),transparent);animation:emptyLogo 1s var(--ease-out) .4s backwards}
#empty-hints{display:flex;flex-direction:column;gap:6px;font-family:var(--mono);font-size:10.5px;color:var(--dim);letter-spacing:.02em;animation:emptyLogo 1s var(--ease-out) .5s backwards}
#empty-hints span{display:flex;align-items:center;gap:8px}
#empty-hints kbd{background:var(--surface2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-family:var(--mono);font-size:9.5px;color:var(--muted)}
@keyframes emptyIn{from{opacity:0}to{opacity:1}}
@keyframes emptyLogo{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
#messages{flex:1;overflow-y:auto;padding:16px 16px 8px 32px;display:flex;flex-direction:column;gap:20px;scrollbar-width:thin;scrollbar-color:var(--border) transparent;position:relative}
#messages::-webkit-scrollbar{width:4px}
#messages::-webkit-scrollbar-thumb{background:var(--border);border-radius:2px}
#messages::-webkit-scrollbar-thumb:hover{background:var(--border-bright)}
/* vertical rail */
#messages::before{content:'';position:absolute;left:14px;top:0;bottom:0;width:1px;background:linear-gradient(180deg,transparent 0%,var(--border) 5%,var(--border) 95%,transparent 100%);pointer-events:none}

/* ── MESSAGES ── */
.msg{display:flex;flex-direction:column;gap:5px;animation:msgIn .3s var(--ease-out);position:relative}
@keyframes msgIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}
.msg-user{align-items:flex-end}
.msg-assistant{align-items:flex-start}
/* rail dot — small, uniform, left of every message */
.msg::before{content:'';position:absolute;left:-21px;top:9px;width:7px;height:7px;border-radius:50%;z-index:2;transition:background .25s var(--ease),border-color .25s var(--ease),box-shadow .25s var(--ease)}
.msg-user::before{background:var(--bg);border:1.5px solid var(--gold-dim)}
.msg-assistant::before{background:var(--surface3);border:1.5px solid var(--border-bright)}
/* streaming: simple glow, no huge rings */
.msg-assistant.streaming::before{background:var(--gold);border-color:var(--gold);box-shadow:0 0 6px rgba(196,161,101,.5);animation:dotGlow 1.6s ease-in-out infinite}
@keyframes dotGlow{0%,100%{box-shadow:0 0 4px rgba(196,161,101,.4)}50%{box-shadow:0 0 10px rgba(196,161,101,.7)}}
.bubble{padding:10px 14px;border-radius:var(--radius);line-height:1.68;white-space:pre-wrap;word-break:break-word;font-size:13px;letter-spacing:-.003em;max-width:100%}
.bubble-user{background:linear-gradient(180deg,var(--surface2),var(--surface));border:1px solid var(--border);border-bottom-right-radius:5px;color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.25),0 0 0 1px rgba(196,161,101,.04)}
.bubble-assistant{background:transparent;color:var(--text);padding:4px 0 4px 0;border-bottom-left-radius:4px;font-weight:400}
.bubble-assistant strong{color:var(--gold-bright);font-weight:600}
.bubble-assistant em{font-family:var(--serif);font-style:italic;color:var(--text)}
.bubble-assistant a{color:var(--gold);text-decoration:underline;text-decoration-color:var(--gold-dim);text-underline-offset:3px;transition:color .15s}
.bubble-assistant a:hover{color:var(--gold-bright)}
.img-attached{max-width:180px;border-radius:10px;border:1px solid var(--border);margin-bottom:4px;box-shadow:0 2px 12px rgba(0,0,0,.3)}
.msg-stopped{font-size:10.5px;color:var(--muted);font-style:italic;padding:5px 0;display:flex;align-items:center;gap:6px;font-family:var(--serif);letter-spacing:.01em}
.msg-stopped::before{content:'';display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--stop);flex-shrink:0;box-shadow:0 0 8px rgba(192,57,43,.5)}
/* Cloud model form */
.cloud-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;z-index:9999;animation:backdropIn .25s var(--ease-out)}
@keyframes backdropIn{from{opacity:0}to{opacity:1}}
.cloud-form{background:linear-gradient(180deg,var(--surface2),var(--surface));border:1px solid var(--border-bright);border-radius:14px;padding:18px 20px;width:320px;max-width:90vw;box-shadow:0 24px 60px rgba(0,0,0,.6),0 0 0 1px rgba(196,161,101,.06),inset 0 1px 0 rgba(255,255,255,.04);display:flex;flex-direction:column;gap:8px;animation:formIn .3s var(--ease-out)}
@keyframes formIn{from{opacity:0;transform:translateY(12px) scale(.96)}to{opacity:1;transform:translateY(0) scale(1)}}
.cloud-title{font-family:var(--serif);font-style:italic;font-size:20px;font-weight:400;color:var(--text);margin-bottom:6px;letter-spacing:-.01em}
.cloud-lbl{font-family:var(--sans);font-size:10px;color:var(--muted);margin-top:6px;letter-spacing:.14em;text-transform:uppercase;font-weight:600}
.cloud-in{background:var(--bg-deep);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:8px 11px;font-family:var(--sans);font-size:12.5px;outline:none;transition:border-color .2s var(--ease),box-shadow .2s var(--ease)}
.cloud-in:focus{border-color:var(--gold-dim);box-shadow:0 0 0 3px var(--gold-glow)}
.cloud-providers{display:flex;gap:7px}
.cloud-prov{flex:1;background:var(--surface);border:1px solid var(--border);color:var(--muted);border-radius:8px;padding:8px 0;font-family:var(--sans);font-size:11.5px;font-weight:500;cursor:pointer;transition:all .2s var(--ease)}
.cloud-prov:hover{color:var(--text);border-color:var(--gold-dim);background:var(--surface2)}
.cloud-prov.active{color:var(--gold);border-color:var(--gold);background:linear-gradient(180deg,rgba(196,161,101,.08),transparent);box-shadow:0 0 0 1px var(--gold-dim) inset}
.cloud-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.cloud-btn{background:var(--surface);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:8px 14px;font-family:var(--sans);font-size:11.5px;font-weight:500;cursor:pointer;transition:border-color .2s,background .2s,transform .1s}
.cloud-btn:hover{border-color:var(--gold-dim);background:var(--surface2)}
.cloud-btn:active{transform:scale(.97)}
.cloud-btn-primary{background:linear-gradient(135deg,var(--gold-bright),var(--gold));color:#1a1200;border-color:var(--gold);font-weight:600;box-shadow:0 2px 10px rgba(196,161,101,.2)}
.cloud-btn-primary:hover{filter:brightness(1.08);box-shadow:0 4px 16px rgba(196,161,101,.35)}
.di-add{cursor:pointer;border-top:1px solid var(--border);margin-top:5px;padding-top:10px;color:var(--muted)}
.di-add:hover{color:var(--text)}
.di-plus{width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:15px;color:var(--gold);flex-shrink:0;font-weight:300}
/* Model row — gold dot indicator replaces the V */
.model-di{position:relative}
.model-di.active{background:linear-gradient(90deg,rgba(196,161,101,.06),transparent)}
.model-di.active::before{content:'';position:absolute;left:3px;top:50%;transform:translateY(-50%);width:3px;height:22px;border-radius:2px;background:var(--gold);box-shadow:0 0 10px var(--gold-glow)}
.model-di.active .di-title{color:var(--gold)}
.model-di .di-check{display:none !important}
/* Edit/remove icons on cloud rows — only on hover */
.model-actions{display:flex;align-items:center;gap:2px;margin-left:6px;opacity:0;transform:translateX(-3px);transition:opacity .18s var(--ease),transform .18s var(--ease)}
.model-di:hover .model-actions{opacity:1;transform:translateX(0)}
.cloud-edit,.cloud-remove{background:transparent;border:1px solid transparent;color:var(--muted);cursor:pointer;padding:5px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;transition:color .15s,border-color .15s,background .15s}
.cloud-edit:hover{color:var(--gold);border-color:var(--gold-dim);background:var(--surface3)}
.cloud-remove:hover{color:#ff6b6b;border-color:rgba(255,107,107,.35);background:rgba(255,107,107,.08)}
/* Confirm dialog */
.confirm-dialog{background:linear-gradient(180deg,var(--surface2),var(--surface));border:1px solid var(--border-bright);border-radius:14px;padding:22px 22px 18px;width:320px;max-width:90vw;box-shadow:0 24px 60px rgba(0,0,0,.65);display:flex;flex-direction:column;gap:12px;animation:formIn .3s var(--ease-out)}
.confirm-title{font-family:var(--serif);font-style:italic;font-size:18px;font-weight:400;color:var(--text);letter-spacing:-.01em}
.confirm-body{font-size:12.5px;color:var(--muted);line-height:1.6;font-weight:300}
.cloud-btn-danger{background:linear-gradient(135deg,#ff6b6b,#c0392b);color:#fff;border-color:#c0392b;font-weight:600;box-shadow:0 2px 10px rgba(192,57,43,.25)}
.cloud-btn-danger:hover{filter:brightness(1.08);box-shadow:0 4px 16px rgba(192,57,43,.4)}
.cloud-lbl-hint{font-weight:400;text-transform:none;letter-spacing:0;color:var(--muted);font-size:10.5px;font-family:var(--serif);font-style:italic}
/* Todo panel */
.todo-panel{border:1px solid var(--border);background:linear-gradient(180deg,var(--surface),var(--bg));border-radius:10px;margin:8px 0;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.2)}
.todo-head{display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-bottom:1px solid var(--border);background:var(--surface2);font-size:11px;position:relative;overflow:hidden}
.todo-head::after{content:'';position:absolute;left:0;bottom:0;height:1px;background:linear-gradient(90deg,var(--gold),var(--gold-dim),transparent);width:var(--todo-progress,0%);transition:width .4s var(--ease-out)}
.todo-title{font-family:var(--sans);font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--text);font-size:10.5px}
.todo-count{font-family:var(--mono);font-size:10px;color:var(--muted);font-variant-numeric:tabular-nums;font-weight:500}
.todo-list{display:flex;flex-direction:column;padding:6px 0}
.todo-row{display:flex;align-items:flex-start;gap:10px;padding:5px 14px;font-size:12px;line-height:1.5;transition:background .15s}
.todo-row:hover{background:var(--surface2)}
.todo-icon{width:14px;text-align:center;flex-shrink:0;color:var(--dim);font-family:var(--mono);font-size:11px;margin-top:2px}
.todo-text{color:var(--text);word-break:break-word}
.todo-done .todo-icon{color:var(--gold)}
.todo-done .todo-text{color:var(--muted);text-decoration:line-through;text-decoration-color:var(--gold-dim)}
.todo-in_progress .todo-icon{color:var(--gold);animation:pulse 1.6s var(--ease) infinite}
.todo-in_progress .todo-text{color:var(--text);font-weight:500}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
/* Token counter */
.token-count{font-family:var(--mono);font-size:10px;color:var(--dim);padding:4px 2px 0;text-align:right;font-variant-numeric:tabular-nums;letter-spacing:.03em}
.token-count.cloud{color:var(--gold-dim)}
/* Files-modified badge */
.files-modified{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10.5px;color:var(--muted);background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:4px 10px;margin-top:6px;letter-spacing:.02em}
.files-modified-count{color:var(--gold);font-weight:600}
.files-modified::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--gold);box-shadow:0 0 6px var(--gold-glow)}
/* Code blocks */
.code-block{position:relative;background:var(--bg-deep);border:1px solid var(--border);border-radius:10px;margin:8px 0;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.25)}
.code-block:hover{border-color:var(--border-bright)}
.code-block pre{padding:14px 16px 14px;overflow-x:auto;font-family:var(--mono);font-size:11.5px;line-height:1.6;color:#E8DFC7;white-space:pre;margin:0;font-variant-ligatures:contextual}
.code-block pre::-webkit-scrollbar{height:5px}
.code-block pre::-webkit-scrollbar-thumb{background:var(--border-bright);border-radius:2px}
.code-lang{font-family:var(--mono);font-size:9.5px;color:var(--gold-dim);padding:6px 14px 0;letter-spacing:.14em;text-transform:uppercase;font-weight:500;display:flex;align-items:center;gap:6px}
.code-lang::before{content:'';width:5px;height:5px;border-radius:50%;background:var(--gold-dim)}
.copy-btn{position:absolute;top:6px;right:6px;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--muted);cursor:pointer;font-size:10px;padding:4px 10px;font-family:var(--sans);font-weight:500;letter-spacing:.04em;transition:color .2s var(--ease),border-color .2s var(--ease),background .2s var(--ease),transform .1s var(--ease);opacity:0}
.code-block:hover .copy-btn{opacity:1}
.copy-btn:hover{color:var(--gold);border-color:var(--gold-dim);background:var(--surface3)}
.copy-btn:active{transform:scale(.95)}

/* ── AI STATUS INDICATOR ── */
.ai-status{display:flex;align-items:center;gap:9px;font-family:var(--serif);font-style:italic;font-size:13px;color:var(--muted);padding:4px 0 8px;min-height:22px;letter-spacing:.01em}
.ai-status-text{font-style:italic}
/* 3-dot wave loader */
.ai-loader{position:relative;width:5px;height:5px;border-radius:50%;background:var(--gold);flex-shrink:0;margin:0 10px;animation:dMid 1.2s ease-in-out infinite}
.ai-loader::before,.ai-loader::after{content:'';position:absolute;top:0;width:5px;height:5px;border-radius:50%;background:var(--gold)}
.ai-loader::before{left:-10px;animation:dLeft 1.2s ease-in-out infinite}
.ai-loader::after{left:10px;animation:dRight 1.2s ease-in-out infinite}
@keyframes dLeft {0%,55%,100%{opacity:.2;transform:translateY(0)} 18%{opacity:1;transform:translateY(-4px)}}
@keyframes dMid  {0%,55%,100%{opacity:.2;transform:translateY(0)} 36%{opacity:1;transform:translateY(-4px)}}
@keyframes dRight{0%,55%,100%{opacity:.2;transform:translateY(0)} 54%{opacity:1;transform:translateY(-4px)}}

/* ── TOOL ACTIVITY (editorial timeline) ── */
.tool-activity{display:flex;flex-direction:column;margin:6px 0 4px;padding-left:16px;position:relative}
.tool-activity::before{content:'';position:absolute;left:3px;top:10px;bottom:10px;width:1px;background:var(--border)}
.tool-item{display:flex;flex-direction:column;gap:2px;padding:3px 0 5px 14px;position:relative;transition:opacity .2s var(--ease);animation:toolIn .22s var(--ease-out)}
@keyframes toolIn{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:translateX(0)}}
.tool-item.has-file{cursor:pointer}
.tool-item.has-file:hover .tool-name{color:var(--gold)}
.tool-item.has-file:hover .tool-file{color:var(--gold-bright)}
/* Dot */
.tool-item::before{content:'';position:absolute;left:-5px;top:9px;width:8px;height:8px;border-radius:50%;background:var(--surface2);border:1.5px solid var(--border-bright);z-index:1;transition:background .3s var(--ease),border-color .3s var(--ease),box-shadow .3s var(--ease)}
.tool-item.running::before{background:var(--gold);border-color:var(--gold);box-shadow:0 0 6px rgba(196,161,101,.5);animation:dotGlow 1.6s ease-in-out infinite}
.tool-item.done::before{background:var(--success);border-color:var(--success)}
.tool-item.error::before{background:var(--stop);border-color:var(--stop)}
.tool-name{font-family:var(--sans);font-size:12.5px;color:var(--text);transition:color .2s var(--ease);line-height:1.45;font-weight:400;letter-spacing:-.003em}
.tool-action{font-weight:600;color:var(--text)}
.tool-file{color:var(--gold-dim);font-weight:400;margin-left:6px;font-family:var(--mono);font-size:11.5px;transition:color .2s var(--ease)}
.tool-detail{font-family:var(--mono);font-size:10px;color:var(--muted);line-height:1.4;letter-spacing:.01em}

/* ── THINK BLOCK ── */
.think-block{border:1px solid var(--border);border-radius:10px;margin-bottom:8px;overflow:hidden;font-family:var(--serif);font-style:italic;font-size:12px;background:var(--surface);transition:border-color .2s var(--ease)}
.think-block:hover{border-color:var(--border-bright)}
.think-header{display:flex;align-items:center;gap:7px;padding:7px 12px;cursor:pointer;color:var(--muted);background:var(--surface);user-select:none;transition:color .2s var(--ease),background .2s var(--ease)}
.think-header:hover{color:var(--text);background:var(--surface2)}
.think-header svg{width:11px;height:11px;flex-shrink:0;color:var(--gold-dim)}
.think-count{margin-left:auto;font-family:var(--mono);font-style:normal;font-size:10px;color:var(--dim);letter-spacing:.04em}
.think-chevron{font-family:var(--sans);font-style:normal;font-size:9px;transition:transform .25s var(--ease);display:inline-block;color:var(--gold-dim)}
.think-block.open .think-chevron{transform:rotate(90deg)}
.think-body{display:none;padding:10px 14px;color:var(--muted);line-height:1.65;white-space:pre-wrap;word-break:break-word;background:var(--bg-deep);border-top:1px solid var(--border);max-height:200px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--border) transparent;font-weight:300}
.think-block.open .think-body{display:block;animation:thinkIn .3s var(--ease-out)}
@keyframes thinkIn{from{opacity:0;max-height:0}to{opacity:1}}

/* ── BOTTOM ── */
#bottom{padding:6px 12px 12px;display:flex;flex-direction:column;gap:6px;flex-shrink:0;position:relative;z-index:2}

/* Active file badge (inline in actions row, like Claude Code) */
.active-file-pill{display:flex;align-items:center;gap:5px;font-size:10.5px;color:var(--muted);flex:1;min-width:0;overflow:hidden;padding:0 4px;cursor:default;transition:color .2s;font-family:var(--mono);letter-spacing:-.01em}
.active-file-pill:hover{color:var(--text)}
.active-file-pill svg{width:11px;height:11px;color:var(--gold-dim);flex-shrink:0}
#active-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
#active-file-name.no-file{opacity:.4;font-family:var(--serif);font-style:italic;font-size:11px}
#file-badge{display:none;align-items:center;gap:5px;padding:4px 10px;background:var(--surface);border:1px solid var(--border);border-radius:8px;cursor:pointer;width:fit-content;max-width:100%;transition:border-color .2s,background .2s,transform .1s;font-family:var(--mono);font-size:10.5px;color:var(--muted)}
#file-badge:hover{border-color:var(--gold-dim);background:var(--surface2)}
#file-badge:active{transform:scale(.98)}
#file-badge.excluded{opacity:.4}
#file-badge svg{width:11px;height:11px;flex-shrink:0;color:var(--gold)}
#file-name-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px}
#file-x{font-size:11px;margin-left:3px;color:var(--gold-dim)}

/* Input box */
#input-box{background:linear-gradient(180deg,var(--surface),var(--bg-deep));border:1px solid var(--border);border-radius:var(--radius);padding:11px 13px;display:flex;flex-direction:column;gap:9px;transition:border-color .25s var(--ease),box-shadow .25s var(--ease);box-shadow:0 2px 16px rgba(0,0,0,.25),inset 0 1px 0 rgba(255,255,255,.02)}
#input-box:focus-within{border-color:var(--gold-dim);box-shadow:0 0 0 3px var(--gold-glow),0 4px 20px rgba(0,0,0,.35),inset 0 1px 0 rgba(196,161,101,.04)}
#img-preview-wrap{display:none;align-items:center;gap:7px;flex-wrap:wrap}
#img-preview-wrap.show{display:flex}
.img-thumb-wrap{position:relative;flex-shrink:0}
.img-thumb{height:46px;width:46px;object-fit:cover;border-radius:8px;border:1px solid var(--border);transition:transform .2s var(--ease)}
.img-thumb-wrap:hover .img-thumb{transform:scale(1.04)}
.img-thumb-del{position:absolute;top:-5px;right:-5px;background:var(--surface3);border:1px solid var(--border-bright);border-radius:50%;width:16px;height:16px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted);font-size:9px;line-height:1;transition:color .15s,background .15s,transform .15s}
.img-thumb-del:hover{color:#ff6b6b;background:rgba(255,107,107,.15);transform:scale(1.1)}
#input{background:transparent;border:none;outline:none;color:var(--text);font-family:var(--sans);font-size:13px;font-weight:400;letter-spacing:-.005em;resize:none;line-height:1.6;min-height:20px;max-height:140px;overflow-y:auto;width:100%;scrollbar-width:none}
#input::-webkit-scrollbar{display:none}
#input::placeholder{color:var(--dim);font-family:var(--serif);font-style:italic;font-size:14px;letter-spacing:.01em}
#input:disabled{opacity:.5;cursor:not-allowed}
#input.streaming{opacity:1;cursor:text}

/* Actions row */
.actions{display:flex;align-items:center;gap:4px}
.actions-right{margin-left:auto;display:flex;align-items:center;gap:3px}
.icon-btn{background:transparent;border:none;color:var(--muted);cursor:pointer;padding:5px 8px;border-radius:8px;display:flex;align-items:center;gap:5px;font-family:var(--sans);font-size:11px;font-weight:500;letter-spacing:-.003em;transition:color .2s var(--ease),background .2s var(--ease),transform .1s var(--ease);position:relative}
.icon-btn:hover{color:var(--text);background:var(--surface2)}
.icon-btn:active{transform:scale(.95)}
.icon-btn svg{width:13px;height:13px}
.icon-btn-label{font-size:10.5px}

/* Send/Stop button */
.send-btn{background:linear-gradient(135deg,var(--gold-bright),var(--gold));border:none;color:#1a1200;cursor:pointer;width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;transition:transform .15s var(--ease),box-shadow .3s var(--ease),filter .2s var(--ease);flex-shrink:0;box-shadow:0 2px 8px rgba(196,161,101,.25),inset 0 1px 0 rgba(255,255,255,.15)}
.send-btn:hover{filter:brightness(1.08);box-shadow:0 4px 16px rgba(196,161,101,.4),0 0 0 3px var(--gold-glow),inset 0 1px 0 rgba(255,255,255,.2)}
.send-btn:active{transform:scale(.92)}
.send-btn:disabled{opacity:.25;cursor:default;box-shadow:none;filter:grayscale(.3)}
.send-btn svg{width:14px;height:14px}
.send-btn.stopping{background:linear-gradient(135deg,#e74c3c,var(--stop));color:#fff;box-shadow:0 2px 10px rgba(192,57,43,.35)}
.send-btn.stopping:hover{box-shadow:0 4px 16px rgba(192,57,43,.5),0 0 0 3px rgba(192,57,43,.18)}
.send-btn.stopping:disabled{opacity:1;cursor:pointer}

/* ── DROPDOWNS ── */
.dropdown{position:fixed;background:rgba(31,26,17,.92);backdrop-filter:blur(20px) saturate(1.3);-webkit-backdrop-filter:blur(20px) saturate(1.3);border:1px solid var(--border-bright);border-radius:12px;padding:5px;z-index:999;width:min(260px,calc(100vw - 16px));box-shadow:0 12px 40px rgba(0,0,0,.7),0 0 0 1px rgba(196,161,101,.05),inset 0 1px 0 rgba(255,255,255,.04);opacity:0;transform:translateY(8px) scale(.98);transition:opacity .22s var(--ease-out),transform .22s var(--ease-out);pointer-events:none}
.dropdown.open{opacity:1;transform:translateY(0) scale(1);pointer-events:all}
.di{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:8px;cursor:pointer;color:var(--text);font-size:12px;transition:background .16s var(--ease),transform .1s var(--ease)}
.di:hover{background:var(--surface3)}
.di:active{transform:scale(.98)}
.di.active{color:var(--gold)}
.di svg{width:15px;height:15px;flex-shrink:0;color:var(--muted);transition:color .15s}
.di:hover svg{color:var(--text)}
.di.active svg{color:var(--gold)}
.di-body{display:flex;flex-direction:column;flex:1;min-width:0}
.di-title{font-size:12px;font-weight:500;letter-spacing:-.005em}
.di-desc{font-size:10.5px;color:var(--muted);margin-top:2px;font-weight:300;letter-spacing:.005em}
.di-check{color:var(--gold);font-size:12px;margin-left:auto;flex-shrink:0}
.sep{height:1px;background:var(--border);margin:5px 2px}
/* Company logo */
.co-logo{width:22px;height:22px;border-radius:6px;object-fit:contain;flex-shrink:0;background:#F5F0E3;padding:2px;box-shadow:0 1px 3px rgba(0,0,0,.3)}
.model-tier{font-family:var(--mono);font-size:9px;color:var(--muted);margin-left:auto;background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:2px 6px;flex-shrink:0;letter-spacing:.06em;text-transform:uppercase;font-weight:500}
</style>
</head>
<body>

<!-- Header -->
<div id="header">
  <button class="hdr-btn" id="hist-btn" title="Chat history">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
  </button>
  <div id="header-spacer"></div>
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
  <div id="history-header">
    <span id="history-header-title">Recents</span>
    <span id="history-workspace"></span>
  </div>
  <div id="history-list"></div>
</div>

<!-- Chat wrap -->
<div id="chat-wrap">
  <div id="empty-state">
    <img src="${logoUri}" alt="Silo"/>
    <h1 id="empty-brand">Silo<em>.</em></h1>
    <div id="empty-divider"></div>
    <p id="empty-subtitle">Your local, editorial coding companion — grounded in context, quiet in its craft.</p>
    <div id="empty-hints">
      <span><kbd>/</kbd> commands</span>
      <span><kbd>@</kbd> reference a file</span>
      <span><kbd>⇧⏎</kbd> new line</span>
    </div>
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
      <!-- Active file pill (like Claude Code bottom bar) -->
      <div class="active-file-pill" id="active-file-pill" title="">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
        <span id="active-file-name" class="no-file">no file</span>
      </div>
      <div class="actions-right">
        <button class="icon-btn" id="turbo-btn" title="Turbo — max GPU/CPU/RAM">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
        </button>
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
  <div class="di" id="review-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
    <div class="di-body"><span class="di-title">Review changes</span><span class="di-desc">AI review of current git diff</span></div>
  </div>
  <div class="di" id="export-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    <div class="di-body"><span class="di-title">Export chat</span><span class="di-desc">Save as Markdown document</span></div>
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

// -- Elements --
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

// -- State --
let pendingImgs      = [];
let currentBubble    = null;
let histOpen         = false;
let isStreaming      = false;
let currentChatId    = null;
let editingId        = null;
let lastModels       = [];
let turboMode        = false;
let currentMode      = 'ask';
let currentModelKind = 'local'; // 'local' | 'cloud' — for token counter
// Think block state
let rawAccum         = '';
let thinkStatus      = 'idle'; // 'idle' | 'thinking' | 'writing'
let thinkBlockEl     = null;
let thinkBodyEl      = null;
let thinkHeaderCount = null;
let currentStatusEl  = null;
// Tool activity
let toolActivityEl   = null;
let activeToolItem   = null;
let workspacePath    = '';
// Per-response tracking
let currentWrap      = null;  // the msg div for current response
let filesModified    = new Set();

// Mode SVG paths
const MODE_ICONS = {
  ask:  '<path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
  auto: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  plan: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
};

// -- Helpers --
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

const TOOL_ACTION = {
  read_file: 'Read', write_file: 'Write', edit_file: 'Edit',
  run_command: 'Run', list_directory: 'List', search_files: 'Search', search_content: 'Search'
};

function toolDisplayName(tool, args) {
  const action = TOOL_ACTION[tool] || tool;
  let detail = '';
  if (tool === 'run_command') {
    detail = (args.command || '').slice(0, 55);
  } else if (args.path) {
    detail = args.path.split(/[\\/]/).pop() || args.path;
  } else if (args.pattern) {
    detail = '"' + args.pattern.slice(0, 40) + '"';
  }
  return { action, detail };
}

function parseToolResult(tool, result) {
  // Extract a short human-readable summary from the tool result string
  if (!result) return '';
  const firstLine = result.split('\\n')[0] || '';
  // "Created: /path (N lines)" / "Updated: ..." / "Edited: ..."
  const linesMatch = result.match(/\\((\\d+) lines?\\)/);
  if (linesMatch) return linesMatch[1] + ' lines';
  // "Found N file(s):" / "Found N match(es):"
  const foundMatch = result.match(/Found (\\d+) (file|match)/);
  if (foundMatch) return foundMatch[1] + ' ' + foundMatch[2] + (parseInt(foundMatch[1]) !== 1 ? 'es' : '');
  // exit code
  const exitMatch = result.match(/exit code: (\\d+)/);
  if (exitMatch) return 'exit ' + exitMatch[1];
  // Directory listing: count entries
  const lines = result.split('\\n').filter(l => l.trim() && !l.startsWith('Directory:')).length;
  if (tool === 'list_directory' && lines) return lines + ' items';
  return firstLine.slice(0, 40);
}

function filePathFromArgs(tool, args) {
  if (['read_file','write_file','edit_file'].includes(tool)) return args.path || '';
  return '';
}
function scrollBottom() {
  messages.scrollTop = messages.scrollHeight;
}

let todoPanelEl = null;
function renderTodos(todos) {
  if (!todos || !todos.length) {
    if (todoPanelEl) { todoPanelEl.remove(); todoPanelEl = null; }
    return;
  }
  if (!todoPanelEl) {
    todoPanelEl = document.createElement('div');
    todoPanelEl.className = 'todo-panel';
    messages.appendChild(todoPanelEl);
  }
  const done = todos.filter(t => t.status === 'done').length;
  const rows = todos.map(t => {
    const icon = t.status === 'done' ? 'check-circle' : t.status === 'in_progress' ? 'circle-dot' : 'circle';
    const sym  = t.status === 'done' ? '\u2713' : t.status === 'in_progress' ? '\u25D0' : '\u25CB';
    const cls  = 'todo-row todo-' + t.status;
    return '<div class="' + cls + '" title="' + esc(t.status) + '"><span class="todo-icon">' + sym + '</span><span class="todo-text">' + esc(t.text) + '</span></div>';
  }).join('');
  todoPanelEl.innerHTML =
    '<div class="todo-head"><span class="todo-title">Plan</span><span class="todo-count">' + done + '/' + todos.length + '</span></div>' +
    '<div class="todo-list">' + rows + '</div>';
  scrollBottom();
}
function showChat() {
  emptyState.style.display = 'none';
  messages.style.display = 'flex';
}
function showEmpty() {
  emptyState.style.display = 'flex';
  messages.style.display = 'none';
}

// -- Input auto-resize --
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

// -- Image handling --
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
    del.className = 'img-thumb-del'; del.textContent = 'x';
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

// -- Error display --
function showError(msg) {
  const el = document.createElement('div');
  el.className = 'msg-stopped';
  el.style.color = '#e74c3c';
  el.textContent = msg;
  messages.appendChild(el);
  scrollBottom();
  showChat();
}

// -- Streaming state --
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

// -- Send / Stop --
function handleSlashCommand(text) {
  const [cmd, ...rest] = text.slice(1).trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case 'clear':
    case 'new':
      messages.innerHTML = '';
      todoPanelEl = null;
      filesModified.clear();
      vscode.postMessage({ type: 'newChat' });
      return true;
    case 'compact':
      vscode.postMessage({ type: 'compact' });
      addSystemNote('Compacting conversation\u2026');
      return true;
    case 'model':
      if (arg) {
        vscode.postMessage({ type: 'setModel', model: arg });
        addSystemNote('Model set to ' + arg);
      } else {
        document.getElementById('model-btn')?.click();
      }
      return true;
    case 'mode':
      if (arg === 'ask' || arg === 'plan' || arg === 'auto') {
        const item = document.querySelector('.mode-item[data-mode="' + arg + '"]');
        if (item) item.click();
        addSystemNote('Mode set to ' + arg);
      } else {
        document.getElementById('mode-btn')?.click();
      }
      return true;
    case 'export':
      vscode.postMessage({ type: 'exportChat' });
      addSystemNote('Exporting chat as Markdown\u2026');
      return true;
    case 'review': {
      const baseRef = arg || 'HEAD~1';
      showChat();
      vscode.postMessage({ type: 'reviewChat', baseRef });
      addSystemNote('Reviewing diff against ' + baseRef + '\u2026');
      return true;
    }
    case 'refactor':
    case 'scan':
      // Send as a chat message in auto mode — agent will scan and suggest
      sendAsAgent('/refactor' === text.slice(0, 8)
        ? (arg || 'Scan the entire workspace for refactoring opportunities, code smells, and quality improvements. Provide a prioritized list with specific file locations.')
        : arg
      );
      return true;
    case 'search':
      if (arg) {
        // Open web search
        vscode.postMessage({ type: 'searchWeb', query: arg });
        addSystemNote('Searching the web for: ' + arg);
      } else {
        addSystemNote('Usage: /search <query>');
      }
      return true;
    case 'git':
      if (!arg) {
        addSystemNote('Usage: /git status | /git commit "msg" | /git branch <name> | /git push');
        return true;
      }
      // Pass to agent as a natural language git request
      sendAsAgent('Run this git operation: ' + arg);
      return true;
    case 'help':
      addSystemNote(
        'Commands:\\n' +
        '  /clear  /new          — start new chat\\n' +
        '  /compact              — summarize conversation\\n' +
        '  /export               — export chat as Markdown\\n' +
        '  /review [ref]         — PR review (diff vs ref, default HEAD~1)\\n' +
        '  /refactor [focus]     — workspace refactor scan\\n' +
        '  /search <query>       — open web search\\n' +
        '  /git <operation>      — run git operation via agent\\n' +
        '  /model [id]           — switch model\\n' +
        '  /mode [ask|plan|auto] — switch mode'
      );
      return true;
    default:
      addSystemNote('Unknown command: /' + cmd + '  (try /help)');
      return true;
  }
}

function sendAsAgent(text) {
  showChat();
  addUserMsg(text, []);
  vscode.postMessage({ type: 'chat', text, imageData: null, turbo: turboMode, mode: 'auto' });
  setStreaming(true);
}
function addSystemNote(text) {
  const el = document.createElement('div');
  el.className = 'msg-stopped';
  el.textContent = text;
  messages.appendChild(el);
  scrollBottom();
}
function send() {
  if (isStreaming) return;
  const text = input.value.trim();
  if (!text && !pendingImgs.length) return;

  if (text.startsWith('/')) {
    if (handleSlashCommand(text)) {
      input.value = '';
      input.style.height = 'auto';
      sendBtn.disabled = true;
      return;
    }
  }

  const imgs = pendingImgs.slice();
  addUserMsg(text, imgs);
  vscode.postMessage({ type: 'chat', text, imageData: imgs[0] ?? null, turbo: turboMode, mode: currentMode });

  input.value = '';
  input.style.height = 'auto';
  sendBtn.disabled = true;
  pendingImgs = [];
  renderImgPreviews();
}

sendBtn.addEventListener('click', () => {
  if (isStreaming) {
    // Immediately update UI - don't wait for round-trip
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

// -- Chat title / rename --
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

// -- Messages --
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

// -- Markdown renderer (code blocks + copy) --
const FENCE = String.fromCharCode(96,96,96);
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

// -- Message handler --
window.addEventListener('message', e => {
  const msg = e.data;
  if (!msg?.type) return;

  switch (msg.type) {
    case 'start': {
      showChat();
      setStreaming(true);
      rawAccum = '';
      thinkStatus = 'idle';
      thinkBlockEl = null; thinkBodyEl = null; thinkHeaderCount = null; currentStatusEl = null;
      toolActivityEl = null; activeToolItem = null;
      filesModified.clear();

      const wrap = document.createElement('div');
      wrap.className = 'msg msg-assistant streaming';
      currentWrap = wrap;

      // Tool activity container (populated dynamically by tool events)
      const toolDiv = document.createElement('div');
      toolDiv.className = 'tool-activity';
      toolDiv.style.display = 'none';
      toolActivityEl = toolDiv;
      wrap.appendChild(toolDiv);

      // Status indicator (orbital loader + text)
      const statusDiv = document.createElement('div');
      statusDiv.className = 'ai-status';
      statusDiv.innerHTML = '<div class="ai-loader"></div><span class="ai-status-text">Working...</span>';
      currentStatusEl = statusDiv;
      wrap.appendChild(statusDiv);

      // Think block (hidden until <think> detected)
      const thinkBlock = document.createElement('div');
      thinkBlock.className = 'think-block';
      thinkBlock.style.display = 'none';
      thinkBlock.innerHTML = [
        '<div class="think-header">',
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">',
        '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
        '<span>Reasoning</span>',
        '<span class="think-count"></span>',
        '<span class="think-chevron">&gt;</span>',
        '</div>',
        '<div class="think-body"></div>'
      ].join('');
      thinkBlock.querySelector('.think-header').addEventListener('click', () => {
        thinkBlock.classList.toggle('open');
        thinkBlock.querySelector('.think-chevron').textContent =
          thinkBlock.classList.contains('open') ? 'v' : '>';
      });
      thinkBlockEl = thinkBlock;
      thinkBodyEl = thinkBlock.querySelector('.think-body');
      thinkHeaderCount = thinkBlock.querySelector('.think-count');
      wrap.appendChild(thinkBlock);

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
      if (!currentBubble) break;
      rawAccum += (msg.token ?? '');

      const tStart = rawAccum.indexOf('<think>');
      const tEnd   = rawAccum.indexOf('</think>');

      if (tStart === -1) {
        // No think block - normal output
        if (thinkStatus !== 'writing') {
          thinkStatus = 'writing';
          if (currentStatusEl) currentStatusEl.querySelector('.ai-status-text').textContent = 'Writing...';
        }
        currentBubble.textContent = rawAccum;
      } else if (tEnd === -1) {
        // Inside <think> block
        if (thinkStatus !== 'thinking') {
          thinkStatus = 'thinking';
          if (currentStatusEl) currentStatusEl.querySelector('.ai-status-text').textContent = 'Thinking...';
          if (thinkBlockEl) thinkBlockEl.style.display = '';
        }
        const thinkContent = rawAccum.slice(tStart + 7);
        if (thinkBodyEl) thinkBodyEl.textContent = thinkContent;
        if (thinkHeaderCount) {
          const wc = thinkContent.trim().split(/\\s+/).filter(Boolean).length;
          thinkHeaderCount.textContent = wc + ' words';
        }
        // Show any text before <think>
        const before = rawAccum.slice(0, tStart).trim();
        if (before) currentBubble.textContent = before;
      } else {
        // </think> seen - extract and finalize
        if (thinkStatus !== 'writing') {
          thinkStatus = 'writing';
          if (currentStatusEl) currentStatusEl.querySelector('.ai-status-text').textContent = 'Writing...';
          const thinkContent = rawAccum.slice(tStart + 7, tEnd);
          if (thinkBodyEl) thinkBodyEl.textContent = thinkContent;
          if (thinkBlockEl) thinkBlockEl.style.display = '';
          if (thinkHeaderCount) {
            const wc = thinkContent.trim().split(/\\s+/).filter(Boolean).length;
            thinkHeaderCount.textContent = wc + ' words';
          }
        }
        const after = rawAccum.slice(tEnd + 8);
        currentBubble.textContent = after;
      }
      scrollBottom();
      break;
    }
    case 'tool_call': {
      if (toolActivityEl) toolActivityEl.style.display = '';
      const statusLabels = {
        read_file: 'Reading...', write_file: 'Writing...', edit_file: 'Editing...',
        run_command: 'Running...', list_directory: 'Exploring...',
        search_files: 'Searching...', search_content: 'Searching...',
        execute_code: 'Executing...', git_commit: 'Committing...',
        git_create_branch: 'Branching...', git_checkout: 'Checking out...',
        git_push: 'Pushing...', git_status: 'Checking status...',
        git_log_summary: 'Reading log...', git_diff_tool: 'Diffing...',
        web_search: 'Searching web...', web_fetch: 'Fetching...',
      };
      if (currentStatusEl) {
        const st = currentStatusEl.querySelector('.ai-status-text');
        if (st) st.textContent = statusLabels[msg.tool] || 'Working...';
      }
      // Track files being written/edited for multi-file indicator
      if (['write_file','edit_file','multi_edit'].includes(msg.tool) && msg.args?.path) {
        filesModified.add(msg.args.path);
      }
      const { action, detail } = toolDisplayName(msg.tool, msg.args || {});
      const filePath = filePathFromArgs(msg.tool, msg.args || {});
      const item = document.createElement('div');
      item.className = 'tool-item running' + (filePath ? ' has-file' : '');
      item.dataset.filePath = filePath;
      item.innerHTML =
        '<div class="tool-name"><span class="tool-action">' + esc(action) + '</span><span class="tool-file">' + esc(detail) + '</span></div>' +
        '<div class="tool-detail"></div>';
      if (filePath) {
        item.addEventListener('click', () => {
          vscode.postMessage({ type: 'openFile', path: filePath, workspace: workspacePath });
        });
      }
      if (toolActivityEl) toolActivityEl.appendChild(item);
      activeToolItem = item;
      scrollBottom();
      break;
    }
    case 'tool_result': {
      if (activeToolItem) {
        activeToolItem.classList.remove('running');
        activeToolItem.classList.add(msg.success ? 'done' : 'error');
        const detail = activeToolItem.querySelector('.tool-detail');
        if (detail) detail.textContent = parseToolResult(msg.tool, msg.result || '');
        activeToolItem = null;
      }
      if (currentStatusEl) {
        const st = currentStatusEl.querySelector('.ai-status-text');
        if (st) st.textContent = 'Thinking...';
      }
      scrollBottom();
      break;
    }
    case 'todos': {
      renderTodos(msg.todos || []);
      break;
    }
    case 'tokens': {
      // Store for display at 'done'
      if (msg.tokens) {
        const total = (msg.tokens.input || 0) + (msg.tokens.output || 0);
        if (currentWrap && total > 0) {
          const tc = document.createElement('div');
          tc.className = 'token-count cloud';
          tc.textContent = (msg.tokens.input || 0) + ' in · ' + (msg.tokens.output || 0) + ' out · ' + total + ' total tokens';
          currentWrap.appendChild(tc);
          scrollBottom();
        }
      }
      break;
    }
    case 'done': {
      if (currentStatusEl) { currentStatusEl.style.display = 'none'; currentStatusEl = null; }
      if (currentBubble) {
        currentBubble.classList.remove('cursor');
        const raw = currentBubble.textContent ?? '';
        if (raw.includes(FENCE)) {
          currentBubble.textContent = '';
          renderContent(currentBubble, raw);
        }
        currentBubble = null;
      }
      // Files-modified indicator (multi-file edit)
      if (currentWrap && filesModified.size > 1) {
        const badge = document.createElement('div');
        badge.className = 'files-modified';
        badge.innerHTML = '<span class="files-modified-count">' + filesModified.size + '</span> files modified';
        currentWrap.appendChild(badge);
      }
      if (currentWrap) currentWrap.classList.remove('streaming');
      setStreaming(false);
      rawAccum = ''; thinkStatus = 'idle'; toolActivityEl = null; activeToolItem = null;
      currentWrap = null; filesModified.clear();
      break;
    }
    case 'stopped': {
      if (currentWrap) currentWrap.classList.remove('streaming');
      if (currentStatusEl) { currentStatusEl.style.display = 'none'; currentStatusEl = null; }
      if (currentBubble) { currentBubble.classList.remove('cursor'); currentBubble = null; }
      if (isStreaming) {
        setStreaming(false);
        const el = document.createElement('div');
        el.className = 'msg-stopped';
        el.textContent = 'Generation stopped';
        messages.appendChild(el);
        scrollBottom();
      }
      rawAccum = ''; thinkStatus = 'idle'; toolActivityEl = null; activeToolItem = null;
      currentWrap = null; filesModified.clear();
      break;
    }
    case 'error': {
      if (currentStatusEl) { currentStatusEl.style.display = 'none'; currentStatusEl = null; }
      if (currentBubble) { currentBubble.classList.remove('cursor'); currentBubble = null; }
      setStreaming(false);
      rawAccum = ''; thinkStatus = 'idle'; toolActivityEl = null; activeToolItem = null;
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
      const activeFileName = document.getElementById('active-file-name');
      const activeFilePill = document.getElementById('active-file-pill');
      if (msg.filename) {
        fileBadge.style.display = 'flex';
        fileLabel.textContent = msg.filename;
        fileBadge.classList.toggle('excluded', !msg.included);
        fileX.textContent = msg.included ? 'x' : '+';
        // Update inline file pill
        if (activeFileName) {
          activeFileName.textContent = msg.filename.split(/[\\/]/).pop() || msg.filename;
          activeFileName.classList.remove('no-file');
        }
        if (activeFilePill) activeFilePill.title = msg.filename;
      } else {
        fileBadge.style.display = 'none';
        if (activeFileName) {
          activeFileName.textContent = 'no file';
          activeFileName.classList.add('no-file');
        }
        if (activeFilePill) activeFilePill.title = '';
      }
      break;
    }
    case 'models': {
      lastModels = msg.models ?? [];
      buildModelMenu(lastModels, msg.current);
      const curM = lastModels.find(m => m.id === msg.current);
      if (curM) currentModelKind = curM.kind || 'local';
      break;
    }
    case 'cloudModelDetail': {
      populateCloudForm(msg.detail);
      break;
    }
    case 'history': {
      buildHistoryList(msg.chats ?? [], msg.currentId);
      const wsEl = document.getElementById('history-workspace');
      if (wsEl) {
        const wp = msg.workspacePath ?? '';
        wsEl.textContent = wp === '__global__' || !wp ? '' : wp;
        wsEl.title = wp;
      }
      break;
    }
    case 'workspace': {
      workspacePath = msg.path || '';
      const wsEl = document.getElementById('history-workspace');
      if (wsEl) {
        const wp = msg.path ?? '';
        wsEl.textContent = wp === '__global__' || !wp ? '' : wp;
        wsEl.title = wp;
      }
      break;
    }
  }
});

// -- File badge --
fileBadge.addEventListener('click', () => vscode.postMessage({ type: 'toggleFile' }));

// -- Turbo mode --
const turboBtn = document.getElementById('turbo-btn');
turboBtn.addEventListener('click', () => {
  turboMode = !turboMode;
  turboBtn.classList.toggle('turbo-on', turboMode);
  turboBtn.title = turboMode
    ? 'Turbo ON - all GPU layers, max threads, 32k context'
    : 'Turbo - max GPU/CPU/RAM';
  vscode.postMessage({ type: 'setTurbo', enabled: turboMode });
});

// -- History --
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
    item.innerHTML =
      '<div class="hist-info">' +
        '<div class="hist-title">' + esc(c.title) + '</div>' +
        '<div class="hist-preview">' + esc(c.preview) + '</div>' +
      '</div>' +
      '<div class="hist-actions">' +
        '<button class="hist-ren" title="Rename">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' +
        '</button>' +
        '<button class="hist-del" title="Delete">x</button>' +
      '</div>';
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

// -- Dropdowns --
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
document.getElementById('review-btn').addEventListener('click', () => {
  closeAll();
  showChat();
  vscode.postMessage({ type: 'reviewChat', baseRef: 'HEAD~1' });
  addSystemNote('Reviewing diff against HEAD~1\u2026');
});
document.getElementById('export-btn').addEventListener('click', () => {
  closeAll();
  vscode.postMessage({ type: 'exportChat' });
  addSystemNote('Exporting chat as Markdown\u2026');
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
    currentMode = modeKey;
    if (MODE_ICONS[modeKey]) modeIcon.innerHTML = MODE_ICONS[modeKey];
    closeAll();
  });
});

document.getElementById('model-btn').addEventListener('click', e => {
  e.stopPropagation();
  openDropdown(document.getElementById('model-menu'), e.currentTarget);
});

const ICON_EDIT = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

function buildModelMenu(models, current) {
  const menu = document.getElementById('model-menu');
  menu.innerHTML = '';
  (models || []).forEach(m => {
    const item = document.createElement('div');
    item.className = 'di model-di' + (m.id === current ? ' active' : '');
    const actions = m.kind === 'cloud'
      ? '<div class="model-actions">' +
          '<button class="cloud-edit" data-id="' + esc(m.id) + '" title="Edit">' + ICON_EDIT + '</button>' +
          '<button class="cloud-remove" data-id="' + esc(m.id) + '" data-label="' + esc(m.label) + '" title="Remove">' + ICON_TRASH + '</button>' +
        '</div>'
      : '';
    item.innerHTML =
      '<img class="co-logo" src="' + esc(m.logoUri) + '" alt="' + esc(m.company) + '" onerror="this.style.display=\\'none\\'"/>' +
      '<div class="di-body">' +
        '<span class="di-title">' + esc(m.label) + '</span>' +
        '<span class="di-desc">' + esc(m.company) + '</span>' +
      '</div>' +
      '<span class="model-tier">' + esc(m.tier) + '</span>' +
      actions;
    item.addEventListener('click', (e) => {
      const editBtn = e.target && e.target.closest && e.target.closest('.cloud-edit');
      const removeBtn = e.target && e.target.closest && e.target.closest('.cloud-remove');
      if (editBtn) {
        e.stopPropagation();
        closeAll();
        openCloudForm(editBtn.dataset.id);
        return;
      }
      if (removeBtn) {
        e.stopPropagation();
        const id = removeBtn.dataset.id;
        const label = removeBtn.dataset.label || 'this AI';
        openConfirmDialog({
          title: 'Remove AI',
          body: 'Delete "' + label + '"? The saved API key will be erased.',
          confirmText: 'Delete',
          destructive: true,
          onConfirm: () => vscode.postMessage({ type: 'removeCloudModel', id })
        });
        return;
      }
      vscode.postMessage({ type: 'setModel', model: m.id });
      modelLabel.textContent = m.tier;
      modelBtnLogo.src = m.logoUri;
      currentModelKind = m.kind || 'local';
      menu.querySelectorAll('.model-di').forEach(d => d.classList.remove('active'));
      item.classList.add('active');
      closeAll();
    });
    menu.appendChild(item);
  });
  // "+ Add AI" footer row
  const addRow = document.createElement('div');
  addRow.className = 'di di-add';
  addRow.innerHTML = '<span class="di-plus">+</span><div class="di-body"><span class="di-title">Add AI</span><span class="di-desc">Connect OpenAI, Claude or Gemini</span></div>';
  addRow.addEventListener('click', () => { closeAll(); openCloudForm(); });
  menu.appendChild(addRow);

  const cur = (models || []).find(m => m.id === current);
  if (cur) {
    modelLabel.textContent = cur.tier;
    modelBtnLogo.src = cur.logoUri;
  }
}

// ── Confirm dialog ───────────────────────────────────────────────
function openConfirmDialog(opts) {
  let bd = document.getElementById('confirm-backdrop');
  if (bd) bd.remove();
  bd = document.createElement('div');
  bd.id = 'confirm-backdrop';
  bd.className = 'cloud-backdrop';
  bd.innerHTML = [
    '<div class="confirm-dialog">',
    '  <div class="confirm-title">' + esc(opts.title || 'Confirm') + '</div>',
    '  <div class="confirm-body">' + esc(opts.body || '') + '</div>',
    '  <div class="cloud-actions">',
    '    <button id="confirm-cancel" class="cloud-btn">Cancel</button>',
    '    <button id="confirm-ok" class="cloud-btn ' + (opts.destructive ? 'cloud-btn-danger' : 'cloud-btn-primary') + '">' + esc(opts.confirmText || 'OK') + '</button>',
    '  </div>',
    '</div>'
  ].join('');
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.addEventListener('click', e => { if (e.target === bd) close(); });
  document.getElementById('confirm-cancel').addEventListener('click', close);
  document.getElementById('confirm-ok').addEventListener('click', () => { try { opts.onConfirm && opts.onConfirm(); } finally { close(); } });
}

// ── Cloud model form (add + edit) ───────────────────────────────
let cloudFormEditId = null;

function openCloudForm(editId) {
  cloudFormEditId = editId || null;
  const isEdit = !!editId;
  let existing = document.getElementById('cloud-form-backdrop');
  if (existing) existing.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'cloud-form-backdrop';
  backdrop.className = 'cloud-backdrop';
  backdrop.innerHTML = [
    '<div class="cloud-form">',
    '  <div class="cloud-title">' + (isEdit ? 'Edit AI' : 'Add AI') + '</div>',
    '  <label class="cloud-lbl">Provider</label>',
    '  <div class="cloud-providers">',
    '    <button data-p="openai"    class="cloud-prov">OpenAI</button>',
    '    <button data-p="anthropic" class="cloud-prov">Claude</button>',
    '    <button data-p="gemini"    class="cloud-prov">Gemini</button>',
    '  </div>',
    '  <label class="cloud-lbl">Model id</label>',
    '  <input id="cloud-model" class="cloud-in" placeholder="gpt-4o-mini"/>',
    '  <label class="cloud-lbl">Nickname (optional)</label>',
    '  <input id="cloud-label" class="cloud-in" placeholder="e.g. GPT-4o"/>',
    '  <label class="cloud-lbl">API key' + (isEdit ? ' <span class="cloud-lbl-hint">(leave empty to keep)</span>' : '') + '</label>',
    '  <input id="cloud-key" class="cloud-in" type="password" placeholder="' + (isEdit ? '•••••••• (unchanged)' : 'sk-... / AIza... / sk-ant-...') + '"/>',
    '  <div class="cloud-actions">',
    '    <button id="cloud-cancel" class="cloud-btn">Cancel</button>',
    '    <button id="cloud-save"   class="cloud-btn cloud-btn-primary">' + (isEdit ? 'Save' : 'Add') + '</button>',
    '  </div>',
    '</div>'
  ].join('');
  document.body.appendChild(backdrop);

  let selectedProv = 'openai';
  const placeholders = {
    openai:    'gpt-4o-mini',
    anthropic: 'claude-sonnet-4-5',
    gemini:    'gemini-2.0-flash'
  };
  const setProv = (p) => {
    selectedProv = p;
    backdrop.querySelectorAll('.cloud-prov').forEach(b => b.classList.toggle('active', b.dataset.p === p));
    document.getElementById('cloud-model').placeholder = placeholders[p] || '';
  };
  backdrop.querySelectorAll('.cloud-prov').forEach(b => {
    b.addEventListener('click', () => setProv(b.dataset.p));
  });
  setProv('openai');

  const close = () => { backdrop.remove(); };
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  document.getElementById('cloud-cancel').addEventListener('click', close);
  document.getElementById('cloud-save').addEventListener('click', () => {
    const remoteModel = document.getElementById('cloud-model').value.trim() || placeholders[selectedProv];
    const label = document.getElementById('cloud-label').value.trim();
    const apiKey = document.getElementById('cloud-key').value.trim();
    if (isEdit) {
      vscode.postMessage({
        type: 'updateCloudModel',
        id: cloudFormEditId,
        provider: selectedProv,
        remoteModel,
        label,
        apiKey: apiKey || undefined,
      });
    } else {
      if (!apiKey) { document.getElementById('cloud-key').focus(); return; }
      vscode.postMessage({
        type: 'addCloudModel',
        provider: selectedProv,
        remoteModel,
        label,
        apiKey,
      });
    }
    document.getElementById('cloud-key').value = '';
    close();
  });

  if (isEdit) {
    vscode.postMessage({ type: 'getCloudModel', id: editId });
  }
}

function populateCloudForm(detail) {
  if (!detail) return;
  const modelIn = document.getElementById('cloud-model');
  const labelIn = document.getElementById('cloud-label');
  if (!modelIn || !labelIn) return;
  const provBtn = document.querySelector('.cloud-prov[data-p="' + detail.provider + '"]');
  if (provBtn) provBtn.click();
  modelIn.value = detail.remoteModel || '';
  labelIn.value = detail.label || '';
}

// -- Global error handler --
window.addEventListener('error', e => {
  showError('JS error: ' + (e.message || 'unknown'));
});
window.addEventListener('unhandledrejection', e => {
  showError('Unhandled error: ' + (e.reason?.message || String(e.reason)));
});

// -- Init --
vscode.postMessage({ type: 'init' });
</script>
</body>
</html>`;
  }
}
