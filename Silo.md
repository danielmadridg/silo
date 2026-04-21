# Silo — Project Memory

## Current stack

| Component | Value |
|---|---|
| **Local model** | `silo-qwen` (custom Ollama model based on **Qwen3 14B**) |
| **Runtime** | Ollama |
| **Backend** | FastAPI + Python (port 8942) |
| **Extension** | VS Code TypeScript webview |
| **Version** | 1.1.0 |

## Architecture

```
VS Code Extension (TypeScript)
  └─ HTTP/SSE → localhost:8942
       └─ FastAPI backend (Python)
            ├─ Agentic tool loop (read/write/run/git/web)
            ├─ BM25 RAG (workspace code retrieval)
            ├─ Cloud routing (OpenAI / Anthropic / Gemini)
            └─ Ollama → silo-qwen (Qwen3 14B)
```

## Key files

- `backend/config.py` — model name, sampling params
- `backend/prompts.py` — system prompt + few-shot examples
- `backend/rag.py` — BM25 keyword retrieval over workspace
- `backend/tools.py` — tool schemas + execution
- `backend/providers.py` — cloud LLM streaming
- `extension/src/panels/SiloChatViewProvider.ts` — main UI
