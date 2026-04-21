import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export async function collectProjectContext(): Promise<string> {
  const maxFiles = vscode.workspace.getConfiguration('silo').get('contextFiles', 5);
  const editor = vscode.window.activeTextEditor;
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const parts: string[] = [];

  // ── Workspace & system info ──
  if (workspaceFolder) {
    const wsPath = workspaceFolder.uri.fsPath;
    const wsName = workspaceFolder.name;
    const fileTree = buildFileTree(wsPath, 2, 60);
    parts.push(`### Workspace: ${wsName}\nPath: ${wsPath}\n\nProject structure:\n${fileTree}`);
  }

  // ── Active file ──
  if (editor) {
    const doc = editor.document;
    const relPath = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, doc.fileName)
      : path.basename(doc.fileName);
    const cursor = editor.selection.active;
    parts.push(`### Active file: ${relPath} (line ${cursor.line + 1}, col ${cursor.character + 1})\n\`\`\`${doc.languageId}\n${doc.getText()}\n\`\`\``);
  }

  // ── Other open files ──
  const openDocs = vscode.workspace.textDocuments
    .filter(d => !d.isUntitled && d !== editor?.document)
    .slice(0, (maxFiles as number) - 1);

  for (const doc of openDocs) {
    if (doc.getText().length > 50000) continue;
    const relPath = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, doc.fileName)
      : path.basename(doc.fileName);
    parts.push(`### Open file: ${relPath}\n\`\`\`${doc.languageId}\n${doc.getText()}\n\`\`\``);
  }

  return parts.join('\n\n');
}

function buildFileTree(dir: string, maxDepth: number, maxEntries: number): string {
  const lines: string[] = [];
  const IGNORE = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', 'build', 'out', '.next', 'coverage']);
  let count = 0;

  function walk(current: string, depth: number, prefix: string) {
    if (depth > maxDepth || count >= maxEntries) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORE.has(entry.name)) continue;
      if (count >= maxEntries) { lines.push(`${prefix}…`); return; }
      const isDir = entry.isDirectory();
      lines.push(`${prefix}${isDir ? '📁 ' : ''}${entry.name}${isDir ? '/' : ''}`);
      count++;
      if (isDir) walk(path.join(current, entry.name), depth + 1, prefix + '  ');
    }
  }

  walk(dir, 1, '');
  return lines.join('\n') || '(empty)';
}

export function getActiveFileInfo(): { code: string; filename: string; language: string } | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;
  return {
    code: editor.document.getText(),
    filename: path.basename(editor.document.fileName),
    language: editor.document.languageId
  };
}

export function getSelectedText(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) return '';
  return editor.document.getText(editor.selection);
}
