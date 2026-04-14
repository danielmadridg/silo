import * as vscode from 'vscode';
import { ChatPanel } from './panels/ChatPanel';
import { SiloChatViewProvider } from './panels/SiloChatViewProvider';
import { getSelectedText } from './contextCollector';
import { streamRefactor } from './backend';
import { SiloCompletionProvider } from './completionProvider';

export function activate(context: vscode.ExtensionContext) {
  // Sidebar panel (activity bar button)
  const provider = new SiloChatViewProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SiloChatViewProvider.viewType, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('silo.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.silo-sidebar');
    }),

    vscode.commands.registerCommand('silo.analyzeFile', () => {
      vscode.commands.executeCommand('workbench.view.extension.silo-sidebar');
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
      vscode.commands.executeCommand('workbench.view.extension.silo-sidebar');
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
