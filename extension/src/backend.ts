import * as vscode from 'vscode';

function getBackendUrl(): string {
  return vscode.workspace.getConfiguration('silo').get('backendUrl', 'http://127.0.0.1:8942');
}

export async function streamChat(
  message: string,
  history: { role: string; content: string }[],
  fileContext: string,
  onToken: (token: string) => void,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${getBackendUrl()}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history, file_context: fileContext }),
    signal,
  });

  if (!response.body) throw new Error('No response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          if (parsed.token) onToken(parsed.token);
        } catch { /* skip malformed chunks */ }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function getCompletion(
  prefix: string,
  suffix: string,
  language: string
): Promise<string> {
  const response = await fetch(`${getBackendUrl()}/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix, suffix, language, max_tokens: 200 }),
  });
  const data = await response.json() as { completion: string };
  return data.completion;
}

export async function streamAnalysis(
  code: string,
  filename: string,
  onToken: (token: string) => void
): Promise<void> {
  const response = await fetch(`${getBackendUrl()}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, filename }),
  });

  if (!response.body) throw new Error('No response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value).split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      try {
        const parsed = JSON.parse(data);
        if (parsed.token) onToken(parsed.token);
      } catch { /* skip malformed chunks */ }
    }
  }
}

export async function streamRefactor(
  code: string,
  instruction: string,
  language: string,
  onToken: (token: string) => void
): Promise<void> {
  const response = await fetch(`${getBackendUrl()}/refactor`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, instruction, language }),
  });
  if (!response.body) throw new Error('No response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value).split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') return;
      try { const p = JSON.parse(data); if (p.token) onToken(p.token); } catch { /* skip */ }
    }
  }
}
