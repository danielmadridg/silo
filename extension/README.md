# Silo — Local & Cloud AI Coding Assistant

Agentic coding assistant for VS Code. Runs fully local on [Ollama](https://ollama.com) or routes to major cloud and OpenAI-compatible AI providers. Your keys never leave your machine.

![Silo](silologo.png)

---

## Why Silo

- **Private by default** — local Ollama backend. Nothing leaves your machine unless you pick a cloud provider.
- **Two curated local models** — `silo-qwen` (Qwen 3.6 27B, full agentic) and `silo-phi` (Microsoft Phi-4 14B, fast chat).
- **Auto model selector** — toggle in toolbar picks Qwen for complex tasks (code, search, analysis) and Phi for short conversational replies.
- **Live thinking stream** — Qwen's reasoning tokens appear in real time in a collapsible Reasoning block. Toggle on/off in the model picker.
- **Plan mode (Claude Code style)** — Think → explore → ask clarifying questions with option buttons → numbered plan → todo checklist → "Switch to Auto" button.
- **Slash commands with autocomplete** — type `/` for a floating list of commands with arrow-key navigation.
- **Markdown rendering** — bold, italic, inline code, headings, lists, blockquotes, code blocks with copy button.
- **Agentic** — reads, writes, edits, runs shell commands, web search, git ops, tracks todos.
- **Approval workflow** — Ask mode shows a diff preview with Apply/Reject before touching files.
- **Explicit context** — use `@file`, `@folder`, `@codebase`, and `@docs` mentions in chat.
- **Checkpoints & checks** — Auto/Edit creates checkpoint patches and runs detected project checks after edits.
- **MCP-ready** — connect external tools through `.silo/mcp.json`.
- **Multi-provider** — pick a cloud model per chat. API keys are stored in VS Code's encrypted SecretStorage.
- **Modes** — `Ask` (chat + approval), `Plan` (research + plan only), `Auto` (full access).

---

## Requirements

- VS Code `1.90+`
- Python `3.10+` (for the local backend)
- [Ollama](https://ollama.com/download) if you want the local model path
- Optional: API keys for cloud providers

---

## Setup

### 1. Install the extension

Search **Silo** in the VS Code Extensions panel, or install the `.vsix` directly.

### 2. Start the backend

```bash
git clone https://github.com/danielmadridg/silo.git
cd silo/backend

python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install fastapi "uvicorn[standard]" httpx pydantic sse-starlette aiofiles
uvicorn main:app --host 127.0.0.1 --port 8942
```

On Windows you can double-click `start-backend.bat`.

### 3. (Optional) Pull local models

Silo ships with two curated local models:

```bash
# Primary — Qwen 3.6 27B (best quality, ~20 tok/s)
ollama pull qwen3.6:27b
ollama create silo-qwen -f backend/Modelfile-qwen

# Light — Microsoft Phi-4 14B (~40 tok/s, 84.8% benchmarks)
ollama pull phi4
ollama create silo-phi -f backend/Modelfile-phi
```

Both use tuned sampling params (temperature 0.25, top_k 40, repeat_penalty 1.12).  
Edit `backend/config.py` to change the default model.

### 4. (Optional) Add a cloud model

Open the Silo sidebar → click the model picker → **+ Add AI** → pick OpenAI / Anthropic / Gemini, paste your API key.

---

## Features

### Modes
| Mode | What it does |
|---|---|
| **Ask** | Conversational plus approval previews for file edits. |
| **Plan** | Read-only tools — read files, grep, list dirs. Great for exploration. |
| **Auto** | Full agent — read, write, edit, run commands, manage todos. |

In Silo `1.3.0`, Ask mode can also prepare file edits as approval previews. The UI shows a unified diff and waits for **Apply** or **Reject**. Auto/Edit mode keeps full access and applies changes directly.

### Slash commands

Type `/` in the input to open an autocomplete picker. Arrow keys to navigate, Enter to confirm.

- `/clear` — start a new chat
- `/compact` — summarize the current chat to save context
- `/review [ref]` — AI review of git diff vs ref (default `HEAD~1`)
- `/search <query>` — web search via the agent
- `/export` — save the current chat as Markdown
- `/mode ask|plan|auto` — switch mode
- `/model [id]` — switch model (or open picker)
- `/help` — list all commands

### Plan mode

Plan mode is a research-first workflow modeled on Claude Code:

1. **Think** — model opens a `<think>` block to reason about scope and ambiguities.
2. **Explore** — uses read-only tools (`read_file`, `search_content`, `git_status`, `web_search`) to understand the codebase.
3. **Clarify** — calls `ask_user` with a question and 2–4 concrete options. UI shows clickable option buttons + a free-text input.
4. **Plan** — produces a numbered plan with files to touch, risks, and open questions.
5. **Todo** — emits a checklist in the side panel.
6. **Hand off** — ends with a "→ Switch to Auto mode to implement" button.

### Auto-model selector

The sun-icon button in the toolbar (active by default) picks the right local model per message:

- Short / conversational / simple questions → **Phi-4** (~40 tok/s)
- Code, search, analysis, refactor, multi-step tasks → **Qwen 3.6** (full tool calling)

Auto-detection uses keyword heuristics in English and Spanish (`busca`, `arregla`, `crea`, `implementa`, `search`, `fix`, `create`, `implement`, etc.). When the prompt is ambiguous it defaults to Qwen.

You can disable Auto and pick a model manually from the model picker.

### Thinking toggle

The Thinking switch at the bottom of the model picker controls Qwen's reasoning mode:

- **ON** — Qwen generates a `<think>` block before responding. Streamed live to the Reasoning panel. Best for complex tasks.
- **OFF** — Qwen replies immediately without reasoning. Best for fast iteration on simple changes.

Phi-4 ignores this toggle (no thinking support).

### Cloud providers
Bring your own key. Add AI includes compact presets for OpenAI, Anthropic Claude, Google Gemini, DeepSeek, xAI, Groq, Mistral, OpenRouter, Together AI, Fireworks, Perplexity, Cerebras, NVIDIA, Moonshot, Qwen, and any custom OpenAI-compatible endpoint.

Keys are stored in `context.secrets` (VS Code SecretStorage — OS keychain on Mac/Windows/Linux). Never written to disk as plain text.

### Workspace context
Silo automatically includes:
- The active file + open tabs
- VS Code diagnostics (problems)
- `git diff` (unstaged changes)
- `SILO.md` or `CLAUDE.md` memory from your workspace root

You can also mention context explicitly:
- `@backend/tools.py` includes a file
- `@backend` includes a folder summary
- `@codebase` asks Silo to lean on workspace retrieval
- `@docs` tells Silo to use documentation/web tools when available

Persistent project instructions can live in `SILO.md`, `CLAUDE.md`, `.silo/SILO.md`, `.silo/CLAUDE.md`, or `.silo/instructions.md`.

### Checkpoints, checks, and MCP

Before Auto/Edit changes or approved Ask edits, Silo writes a checkpoint patch to `.silo/checkpoints/`. After Auto/Edit file changes, Silo detects common project checks and streams the result back into the chat so it can fix failures.

MCP servers can be configured in `.silo/mcp.json`:

```json
{
  "mcpServers": {
    "example": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": {}
    }
  }
}
```

### Multi-chat history
The sidebar keeps your previous chats. Empty chats are discarded. Long chats auto-compact.

### Inline tools
- **Analyze file** — full review of the active file
- **Refactor selection** — right-click → Silo: Refactor Selection
- **Explain selection** — right-click → Silo: Explain Selection
- **Inline completions** — Tab to accept

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `silo.backendUrl` | `http://127.0.0.1:8942` | Backend URL (bind to loopback by default) |
| `silo.contextFiles` | `5` | Open files included in context |
| `silo.backendPath` | `""` | Path to the backend folder. Leave empty for auto-detect |

---

## Security

- Backend binds to `127.0.0.1` only.
- API keys live in VS Code SecretStorage (OS keychain).
- No telemetry. No analytics. No outbound calls except to your configured provider.
- Source on GitHub — audit anything.

---

## Source

[github.com/danielmadridg/silo](https://github.com/danielmadridg/silo)

## License

MIT — see [LICENSE](LICENSE).
