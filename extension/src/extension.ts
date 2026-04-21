import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { SiloChatViewProvider } from './panels/SiloChatViewProvider';
import { getSelectedText } from './contextCollector';
import { streamRefactor } from './backend';
import { SiloCompletionProvider } from './completionProvider';

// ── Output channel ────────────────────────────────────────────────────────
const out = vscode.window.createOutputChannel('Silo Backend');

// Exported so the chat provider can await it before sending messages
export let backendReady: Promise<boolean>;

// ── Helpers ───────────────────────────────────────────────────────────────
function getBackendUrl(): string {
  return vscode.workspace.getConfiguration('silo').get('backendUrl', 'http://127.0.0.1:8942');
}

async function isBackendUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch(`${getBackendUrl()}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    return false;
  }
}

function findBackendDir(context: vscode.ExtensionContext): string | null {
  const configured = vscode.workspace.getConfiguration('silo').get<string>('backendPath', '').trim();
  if (configured) {
    if (fs.existsSync(path.join(configured, 'main.py'))) return configured;
    out.appendLine(`[warn] silo.backendPath set to "${configured}" but main.py not found there`);
  }

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const candidate = path.join(folder.uri.fsPath, 'backend');
    out.appendLine(`[scan] checking ${candidate}`);
    if (fs.existsSync(path.join(candidate, 'main.py'))) return candidate;
  }

  const fromExt = path.join(path.dirname(context.extensionUri.fsPath), 'backend');
  out.appendLine(`[scan] checking ${fromExt}`);
  if (fs.existsSync(path.join(fromExt, 'main.py'))) return fromExt;

  return null;
}

function findPython(backendDir: string): string | null {
  const candidates = [
    path.join(backendDir, '.venv', 'Scripts', 'python.exe'),
    path.join(backendDir, '.venv', 'bin', 'python'),
    path.join(backendDir, 'venv', 'Scripts', 'python.exe'),
    path.join(backendDir, 'venv', 'bin', 'python'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) { out.appendLine(`[python] found at ${p}`); return p; }
  }
  return null;
}

async function warmupModel(): Promise<void> {
  const url = getBackendUrl();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.text = '$(loading~spin) Silo: loading model into GPU…';
  status.tooltip = 'Pre-loading model weights into VRAM so your first message is instant';
  status.show();
  out.appendLine('[warmup] pre-loading model into VRAM…');
  try {
    const ctrl = new AbortController();
    // Give it up to 3 minutes — large models take time for first load
    const timer = setTimeout(() => ctrl.abort(), 180_000);
    await fetch(`${url}/warmup`, { method: 'POST', signal: ctrl.signal });
    clearTimeout(timer);
    out.appendLine('[warmup] model loaded and ready');
  } catch (e: any) {
    out.appendLine(`[warmup] ${e?.message ?? e}`);
  } finally {
    status.dispose();
  }
}

async function ensureBackend(context: vscode.ExtensionContext): Promise<boolean> {
  out.appendLine('[start] checking if backend is already running…');

  if (await isBackendUp()) {
    out.appendLine('[ok] backend already running');
    return true;
  }

  out.appendLine('[start] backend not running, locating backend dir…');
  const backendDir = findBackendDir(context);
  if (!backendDir) {
    out.appendLine('[error] backend directory not found — set silo.backendPath in settings');
    return false;
  }
  out.appendLine(`[found] backend dir: ${backendDir}`);

  const python = findPython(backendDir);
  if (!python) {
    out.appendLine('[error] no Python venv found — run setup first');
    vscode.window.showWarningMessage('Silo: Backend venv not found. Run setup first.', 'Show Log')
      .then(v => v && out.show());
    return false;
  }

  // Show status bar while starting
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.text = '$(loading~spin) Silo: starting backend…';
  status.tooltip = 'Click to see Silo backend log';
  status.command = 'silo.showBackendLog';
  status.show();

  out.appendLine(`[spawn] ${python} -m uvicorn main:app --port 8942`);

  const proc = cp.spawn(
    python,
    ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8942', '--log-level', 'info'],
    { cwd: backendDir, windowsHide: true, env: { ...process.env } }
  );

  proc.stdout?.on('data', (d: Buffer) => out.append(d.toString()));
  proc.stderr?.on('data', (d: Buffer) => out.append(d.toString()));
  proc.on('error', err => {
    out.appendLine(`[error] spawn failed: ${err.message}`);
    status.dispose();
    vscode.window.showErrorMessage(`Silo: Failed to start backend — ${err.message}`, 'Show Log')
      .then(v => v && out.show());
  });
  proc.on('exit', code => out.appendLine(`[exit] backend exited with code ${code}`));

  // Kill backend when VS Code closes
  context.subscriptions.push({ dispose: () => { try { proc.kill(); } catch {} } });

  // Poll until ready (up to 30 s)
  out.appendLine('[wait] waiting for backend to be ready…');
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    if (proc.exitCode !== null) {
      out.appendLine(`[fail] process exited early (code ${proc.exitCode})`);
      break;
    }
    if (await isBackendUp()) {
      out.appendLine('[ready] backend is up!');
      status.dispose();
      const ok = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
      ok.text = '$(check) Silo ready';
      ok.show();
      setTimeout(() => ok.dispose(), 4000);
      return true;
    }
  }

  status.dispose();
  out.appendLine('[fail] backend did not become ready in time');
  vscode.window.showErrorMessage('Silo: Backend failed to start.', 'Show Log')
    .then(v => v && out.show());
  return false;
}

// ── Extension activate ────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('silo.showBackendLog', () => out.show())
  );

  // Start backend + warm up model (non-blocking)
  backendReady = ensureBackend(context).then(async ok => {
    if (!ok) return false;
    await warmupModel();
    return true;
  });

  const provider = new SiloChatViewProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SiloChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('silo.openChat', () => provider.createOrShow()),

    vscode.commands.registerCommand('silo.analyzeFile', () => {
      provider.createOrShow();
      setTimeout(() => provider.handleAnalyze(), 300);
    }),

    vscode.commands.registerCommand('silo.refactorSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      const selected = getSelectedText();
      if (!selected || !editor) {
        return vscode.window.showWarningMessage('Silo: No text selected');
      }
      const instruction = await vscode.window.showInputBox({
        prompt: 'Refactoring instruction',
        placeHolder: 'e.g. Convert to async/await, add type hints, optimize performance...'
      });
      if (!instruction) return;
      let refactored = '';
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Silo: Refactoring...', cancellable: false },
        async () => {
          await streamRefactor(selected, instruction, editor.document.languageId, t => { refactored += t; });
        }
      );
      await editor.edit(eb => eb.replace(editor.selection, refactored.trim()));
    }),

    vscode.commands.registerCommand('silo.explainSelection', async () => {
      const selected = getSelectedText();
      if (!selected) {
        return vscode.window.showWarningMessage('Silo: No text selected');
      }
      vscode.commands.executeCommand('silo.chatView.focus');
      await new Promise(r => setTimeout(r, 300));
      provider.sendMessage(`Explain this code:\n\`\`\`\n${selected}\n\`\`\``);
    }),

    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new SiloCompletionProvider()
    )
  );
}

export function deactivate() {}
