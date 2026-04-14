# Silo — Local AI Coding Assistant

A fully local AI coding assistant for VS Code. No API keys, no cloud, no data leaving your machine.

Powered by [Ollama](https://ollama.com) + Qwen2.5-Coder.

---

## Requirements

- [Ollama](https://ollama.com/download) installed and running
- A capable GPU (8GB+ VRAM recommended) or fast CPU
- The Silo backend running locally

---

## Setup (one time)

### 1. Install Ollama

Download from [ollama.com/download](https://ollama.com/download) and install it.

### 2. Pull the model

Open a terminal and run:

```bash
ollama pull qwen2.5-coder:32b
```

> Lower VRAM? Use a smaller model instead:
> ```bash
> ollama pull qwen2.5-coder:14b
> ```

### 3. Download and start the backend

Clone the repo and start the backend:

```bash
git clone https://github.com/danielmadridg/silo.git
cd silo

# Create virtual environment
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate
# Mac/Linux
source .venv/bin/activate

pip install fastapi "uvicorn[standard]" httpx pydantic sse-starlette aiofiles
uvicorn main:app --host 127.0.0.1 --port 8942
```

> On Windows you can also just double-click `start-backend.bat`

### 4. Install the extension

Install from the VS Code Marketplace by searching **Silo** or from the Extensions panel.

---

## Features

- **Chat panel** — ask anything about your code with full project context
- **Inline completions** — Tab to accept AI suggestions as you type
- **File analysis** — detect bugs, performance issues and get refactoring suggestions
- **Inline refactoring** — select code, give an instruction, changes apply directly in the editor
- **Code explanation** — select any code and ask Silo to explain it

---

## Usage

| Command | Description |
|---|---|
| `Silo: Open Chat` | Opens the chat panel |
| `Silo: Analyze Current File` | Analyzes the active file |
| `Silo: Refactor Selection` | Refactors selected code |
| `Silo: Explain Selection` | Explains selected code |

Access commands via `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac).

Right-click on selected code for quick access to Refactor and Explain.

---

## Configuration

| Setting | Default | Description |
|---|---|---|
| `silo.backendUrl` | `http://127.0.0.1:8942` | Silo backend URL |
| `silo.contextFiles` | `5` | Number of open files included in context |

To use a different model, edit `backend/config.py`:
```python
MODEL_NAME = "qwen2.5-coder:14b"  # or any model in Ollama
```

---

## Source

[github.com/danielmadridg/silo](https://github.com/danielmadridg/silo)
