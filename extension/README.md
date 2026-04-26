# Silo — Local & Cloud AI Coding Assistant

Agentic coding assistant for VS Code. Runs fully local on [Ollama](https://ollama.com) or routes to **OpenAI**, **Anthropic Claude**, and **Google Gemini**. Your keys never leave your machine.

![Silo](silologo.png)

---

## Why Silo

- **Private by default** — local Ollama backend. Nothing leaves your machine unless you pick a cloud provider.
- **Agentic** — reads, writes, edits, runs shell commands, tracks todos, remembers context.
- **Multi-provider** — pick a cloud model per chat. API keys are stored in VS Code's encrypted SecretStorage.
- **Modes** — `Ask` (chat only), `Plan` (read-only tools), `Auto` (full access).

---

## Requirements

- VS Code `1.90+`
- Python `3.10+` (for the local backend)
- [Ollama](https://ollama.com/download) if you want the local model path
- Optional: API keys for OpenAI / Anthropic / Gemini

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

# Balanced — Microsoft Phi-4 14B (~40 tok/s, 84.8% benchmarks)
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
| **Ask** | Conversational. No tool use. |
| **Plan** | Read-only tools — read files, grep, list dirs. Great for exploration. |
| **Auto** | Full agent — read, write, edit, run commands, manage todos. |

### Slash commands
- `/clear` — clear the current chat
- `/new` — start a new chat
- `/compact` — summarize the current chat to save context
- `/mode ask|plan|auto` — switch mode

### Cloud providers
Bring your own key. Supported:
- **OpenAI** (GPT-4o, GPT-4.1, o-series)
- **Anthropic** (Claude 4.x family)
- **Google** (Gemini 2.x family)

Keys are stored in `context.secrets` (VS Code SecretStorage — OS keychain on Mac/Windows/Linux). Never written to disk as plain text.

### Workspace context
Silo automatically includes:
- The active file + open tabs
- VS Code diagnostics (problems)
- `git diff` (unstaged changes)
- `SILO.md` or `CLAUDE.md` memory from your workspace root

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
