import * as vscode from 'vscode';
import * as path from 'path';

export async function collectProjectContext(): Promise<string> {
  const maxFiles = vscode.workspace.getConfiguration('silo').get('contextFiles', 5);
  const editor = vscode.window.activeTextEditor;
  const parts: string[] = [];

  if (editor) {
    const doc = editor.document;
    parts.push(`### Active file: ${path.basename(doc.fileName)}\n\`\`\`${doc.languageId}\n${doc.getText()}\n\`\`\``);
  }

  const openDocs = vscode.workspace.textDocuments
    .filter(d => !d.isUntitled && d !== editor?.document)
    .slice(0, (maxFiles as number) - 1);

  for (const doc of openDocs) {
    if (doc.getText().length > 50000) continue;
    parts.push(`### File: ${path.basename(doc.fileName)}\n\`\`\`${doc.languageId}\n${doc.getText()}\n\`\`\``);
  }

  return parts.join('\n\n');
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
