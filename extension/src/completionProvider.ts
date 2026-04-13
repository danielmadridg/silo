import * as vscode from 'vscode';
import { getCompletion } from './backend';

export class SiloCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: NodeJS.Timeout | undefined;

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | null> {
    return new Promise((resolve) => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) return resolve(null);

        const offset = document.offsetAt(position);
        const fullText = document.getText();
        const prefix = fullText.slice(Math.max(0, offset - 3000), offset);
        const suffix = fullText.slice(offset, Math.min(fullText.length, offset + 500));

        try {
          const completion = await getCompletion(prefix, suffix, document.languageId);
          if (!completion || token.isCancellationRequested) return resolve(null);
          resolve(new vscode.InlineCompletionList([
            new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))
          ]));
        } catch {
          resolve(null);
        }
      }, 600);
    });
  }
}
