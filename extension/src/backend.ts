import * as vscode from 'vscode';

function getBackendUrl(): string {
  return vscode.workspace.getConfiguration('silo').get('backendUrl', 'http://127.0.0.1:8942');
}

export interface ToolEvent {
  type: 'tool_call' | 'tool_result' | 'todos' | 'tokens' | 'ask_user' | 'thinking_token';
  tool?: string;
  args?: Record<string, any>;
  result?: string;
  success?: boolean;
  todos?: { text: string; status: 'pending' | 'in_progress' | 'done' }[];
  tokens?: { input: number; output: number };
  ask_user?: { question: string; options: string[] };
  thinking_token?: string;
}

export interface StreamChatOptions {
  signal?: AbortSignal;
  turbo?: boolean;
  workspace?: string;
  mode?: 'ask' | 'plan' | 'auto';
  diagnostics?: string;
  gitDiff?: string;
  localModel?: string;    // local Ollama model override (e.g. 'silo-phi')
  thinking?: boolean;     // enable Qwen thinking mode (default true)
  onToolEvent?: (event: ToolEvent) => void;
  // Cloud provider routing
  provider?: string;      // '' | 'openai' | 'anthropic' | 'gemini'
  remoteModel?: string;   // e.g. 'gpt-4o', 'claude-sonnet-4-5', 'gemini-2.0-flash'
  apiKey?: string;
}

export async function streamChat(
  message: string,
  history: { role: string; content: string }[],
  fileContext: string,
  onToken: (token: string) => void,
  opts: StreamChatOptions = {}
): Promise<void> {
  const { signal, turbo = false, workspace = '', mode = 'auto', diagnostics = '', gitDiff = '', localModel = '', thinking = true, onToolEvent, provider = '', remoteModel = '', apiKey = '' } = opts;

  const response = await fetch(`${getBackendUrl()}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      history,
      file_context: fileContext,
      turbo,
      workspace,
      mode,
      diagnostics,
      git_diff: gitDiff,
      local_model: localModel,
      thinking,
      provider,
      remote_model: remoteModel,
      api_key: apiKey,
    }),
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
          if (parsed.token !== undefined) {
            onToken(parsed.token);
          } else if (parsed.tokens && onToolEvent) {
            onToolEvent({ type: 'tokens', tokens: parsed.tokens });
          } else if (parsed.todos && onToolEvent) {
            onToolEvent({ type: 'todos', todos: parsed.todos });
          } else if (parsed.ask_user && onToolEvent) {
            onToolEvent({ type: 'ask_user', ask_user: parsed.ask_user });
          } else if (parsed.thinking_token !== undefined && onToolEvent) {
            onToolEvent({ type: 'thinking_token', thinking_token: parsed.thinking_token });
          } else if (parsed.tool_call && onToolEvent) {
            onToolEvent({ type: 'tool_call', tool: parsed.tool_call, args: parsed.args });
          } else if (parsed.tool_result && onToolEvent) {
            onToolEvent({ type: 'tool_result', tool: parsed.tool_result, result: parsed.result, success: parsed.success });
          } else if (parsed.error) {
            throw new Error(parsed.error);
          }
        } catch (e: any) {
          if (e?.message && !e.message.includes('JSON')) throw e;
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function streamReview(
  workspace: string,
  baseRef: string,
  onToken: (token: string) => void,
  opts: { provider?: string; remoteModel?: string; apiKey?: string; signal?: AbortSignal } = {}
): Promise<void> {
  const { provider = '', remoteModel = '', apiKey = '', signal } = opts;
  const response = await fetch(`${getBackendUrl()}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace,
      base_ref: baseRef || 'HEAD~1',
      provider,
      remote_model: remoteModel,
      api_key: apiKey,
    }),
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
          if (parsed.token !== undefined) onToken(parsed.token);
          else if (parsed.error) throw new Error(parsed.error);
        } catch (e: any) {
          if (e?.message && !e.message.includes('JSON')) throw e;
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function compactHistory(
  history: { role: string; content: string }[]
): Promise<string> {
  const response = await fetch(`${getBackendUrl()}/compact`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ history }),
  });
  const data = await response.json() as { summary: string };
  return data.summary || '';
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
