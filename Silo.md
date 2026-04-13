# SILO — Plan de Construcción Completo
### Sistema LLM local equivalente a Claude Code para VS Code
> Hardware objetivo: RTX 5080 · 64 GB RAM · 100% local · Sin APIs externas

---

## Decisiones técnicas fijadas

| Componente | Decisión | Justificación |
|---|---|---|
| **Modelo base** | `Qwen2.5-Coder-32B-Instruct` (GGUF Q5_K_M) | Mejor benchmark en coding tasks entre modelos open-source ejecutables localmente. 32B en Q5 cabe en VRAM de una 5080 (16 GB) con offload parcial a RAM |
| **Runtime** | `llama.cpp` con bindings Python (`llama-cpp-python`) | Máximo rendimiento en GPU NVIDIA, soporte nativo CUDA, Flash Attention 2 |
| **Backend API** | FastAPI + WebSockets | Bajo overhead, streaming nativo, fácil integración con extensión VS Code |
| **Extensión VS Code** | TypeScript + Language Model API (VS Code 1.90+) | Acceso nativo al contexto del editor, soporte para inline completions y chat panel |
| **Protocolo interno** | OpenAI-compatible REST + SSE streaming | Reutiliza librerías existentes en el lado del cliente |

---

## Arquitectura del sistema

```
┌─────────────────────────────────────────────────────┐
│                    VS Code                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │  Chat Panel  │  │  Inline      │  │  Commands │ │
│  │  (Webview)   │  │  Completions │  │  Palette  │ │
│  └──────┬───────┘  └──────┬───────┘  └─────┬─────┘ │
│         └─────────────────┴──────────────────┘      │
│                      Silo Extension                  │
│              (TypeScript · Extension Host)           │
└────────────────────────┬────────────────────────────┘
                         │ HTTP/SSE (localhost:8942)
┌────────────────────────▼────────────────────────────┐
│                  Silo Backend                        │
│              (Python · FastAPI)                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ Context      │  │  Prompt      │  │  Session  │  │
│  │ Collector    │  │  Builder     │  │  Manager  │  │
│  └──────┬───────┘  └──────┬───────┘  └─────┬─────┘  │
│         └─────────────────┴──────────────────┘       │
│                    llama-cpp-python                   │
└────────────────────────┬────────────────────────────┘
                         │ CUDA / cuBLAS
┌────────────────────────▼────────────────────────────┐
│         Qwen2.5-Coder-32B-Instruct Q5_K_M           │
│              (RTX 5080 + RAM offload)                │
└─────────────────────────────────────────────────────┘
```

---

## Fases de construcción

| Fase | Nombre | Entregable |
|------|--------|------------|
| **1** | Entorno y modelo | Modelo corriendo, inferencia verificada |
| **2** | Backend Silo | API FastAPI con streaming y gestión de contexto |
| **3** | Extensión VS Code — Chat | Panel de chat funcional conectado al backend |
| **4** | Extensión VS Code — Completions | Autocompletado inline en el editor |
| **5** | Funcionalidades avanzadas | Refactoring, análisis de archivos, context del proyecto |
| **6** | Optimización y empaquetado | `.vsix` listo para distribución/publicación |

---

## FASE 1 — Entorno y modelo

**Qué se hace:** Instalar dependencias CUDA, compilar `llama-cpp-python` con soporte GPU, descargar el modelo y verificar que la inferencia funciona con la RTX 5080.

### Pasos

**1. Instalar dependencias del sistema**
```bash
sudo apt update && sudo apt install -y \
  build-essential cmake git curl wget \
  python3.11 python3.11-venv python3.11-dev \
  nvidia-cuda-toolkit
```

**2. Verificar CUDA**
```bash
nvcc --version
nvidia-smi
```
> Confirmar que aparece la RTX 5080 y versión CUDA ≥ 12.1

**3. Crear entorno virtual del backend**
```bash
mkdir -p ~/silo/backend
cd ~/silo/backend
python3.11 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
```

**4. Compilar e instalar `llama-cpp-python` con CUDA**
```bash
CMAKE_ARGS="-DGGML_CUDA=on -DGGML_CUDA_F16=on" \
FORCE_CMAKE=1 \
pip install llama-cpp-python --no-cache-dir --verbose
```
> Este paso tarda ~5–10 minutos. Si falla, verificar que `nvcc` está en el PATH.

**5. Instalar dependencias del backend**
```bash
pip install fastapi uvicorn[standard] sse-starlette pydantic tiktoken aiofiles
```

**6. Descargar el modelo**
```bash
mkdir -p ~/silo/models
cd ~/silo/models

# Instalar huggingface-hub para descarga gestionada
pip install huggingface-hub

python3 -c "
from huggingface_hub import hf_hub_download
hf_hub_download(
    repo_id='Qwen/Qwen2.5-Coder-32B-Instruct-GGUF',
    filename='qwen2.5-coder-32b-instruct-q5_k_m.gguf',
    local_dir='/root/silo/models'
)
print('Modelo descargado correctamente.')
"
```
> Tamaño aproximado: ~22 GB. Asegúrate de tener espacio en disco.

**7. Test de inferencia**
```bash
cd ~/silo/backend
source .venv/bin/activate

python3 - <<'EOF'
from llama_cpp import Llama

llm = Llama(
    model_path="/root/silo/models/qwen2.5-coder-32b-instruct-q5_k_m.gguf",
    n_gpu_layers=-1,       # Todas las capas a GPU
    n_ctx=8192,
    n_batch=512,
    flash_attn=True,
    verbose=False
)

output = llm(
    "<|im_start|>user\nEscribe una función Python que calcule el factorial de n de forma recursiva.<|im_end|>\n<|im_start|>assistant\n",
    max_tokens=300,
    stop=["<|im_end|>"],
    echo=False
)
print(output["choices"][0]["text"])
EOF
```
> **Criterio de éxito:** El modelo devuelve código Python coherente en menos de 30 segundos.

---

## FASE 2 — Backend Silo

**Qué se hace:** Construir la API FastAPI con endpoints de chat (streaming SSE), completions y análisis de archivos. Incluye gestión de sesiones y construcción de prompts con contexto del proyecto.

### Estructura de archivos
```
~/silo/backend/
├── main.py
├── config.py
├── model.py
├── context.py
├── prompts.py
└── routers/
    ├── chat.py
    ├── completions.py
    └── analysis.py
```

### Pasos

**1. Crear `config.py`**
```python
# ~/silo/backend/config.py
from pathlib import Path

MODEL_PATH = str(Path.home() / "silo/models/qwen2.5-coder-32b-instruct-q5_k_m.gguf")
N_GPU_LAYERS = -1          # Todas las capas en GPU
N_CTX = 16384              # Ventana de contexto
N_BATCH = 512
FLASH_ATTN = True
MAX_TOKENS_CHAT = 2048
MAX_TOKENS_COMPLETE = 256
PORT = 8942
HOST = "127.0.0.1"
```

**2. Crear `model.py`**
```python
# ~/silo/backend/model.py
from llama_cpp import Llama
from config import *
import threading

_lock = threading.Lock()
_llm: Llama | None = None

def get_model() -> Llama:
    global _llm
    if _llm is None:
        _llm = Llama(
            model_path=MODEL_PATH,
            n_gpu_layers=N_GPU_LAYERS,
            n_ctx=N_CTX,
            n_batch=N_BATCH,
            flash_attn=FLASH_ATTN,
            verbose=False,
            chat_format="chatml"
        )
    return _llm

def get_lock():
    return _lock
```

**3. Crear `prompts.py`**
```python
# ~/silo/backend/prompts.py

SYSTEM_PROMPT = """You are Silo, an expert AI coding assistant running entirely on the user's local machine.
You have deep knowledge of software engineering, debugging, refactoring, and code architecture.
Always respond with precise, production-quality code. Prefer concise explanations unless the user asks for detail.
When analyzing code, identify bugs, performance issues, and improvements proactively.
Language: respond in the same language the user writes in."""

def build_chat_messages(history: list[dict], user_message: str, file_context: str = "") -> list[dict]:
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if file_context:
        messages.append({
            "role": "system",
            "content": f"## Project context (current files)\n\n{file_context}"
        })
    messages.extend(history)
    messages.append({"role": "user", "content": user_message})
    return messages

def build_completion_prompt(prefix: str, suffix: str, language: str) -> str:
    return (
        f"<|fim_prefix|>```{language}\n{prefix}"
        f"<|fim_suffix|>{suffix}\n```<|fim_middle|>"
    )

def build_analysis_prompt(code: str, filename: str) -> list[dict]:
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": (
            f"Analyze the following file `{filename}` and provide:\n"
            "1. A brief summary of what the code does\n"
            "2. Identified bugs or issues\n"
            "3. Performance improvements\n"
            "4. Refactoring suggestions\n\n"
            f"```\n{code}\n```"
        )}
    ]
```

**4. Crear `routers/chat.py`**
```python
# ~/silo/backend/routers/chat.py
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import json
from model import get_model, get_lock
from prompts import build_chat_messages
from config import MAX_TOKENS_CHAT

router = APIRouter()

class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []
    file_context: str = ""

@router.post("/chat")
async def chat(req: ChatRequest):
    messages = build_chat_messages(req.history, req.message, req.file_context)

    def generate():
        llm = get_model()
        with get_lock():
            stream = llm.create_chat_completion(
                messages=messages,
                max_tokens=MAX_TOKENS_CHAT,
                stream=True,
                temperature=0.2,
                top_p=0.95,
                repeat_penalty=1.1
            )
            for chunk in stream:
                delta = chunk["choices"][0].get("delta", {})
                if "content" in delta and delta["content"]:
                    data = json.dumps({"token": delta["content"]})
                    yield f"data: {data}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
```

**5. Crear `routers/completions.py`**
```python
# ~/silo/backend/routers/completions.py
from fastapi import APIRouter
from pydantic import BaseModel
from model import get_model, get_lock
from prompts import build_completion_prompt
from config import MAX_TOKENS_COMPLETE

router = APIRouter()

class CompletionRequest(BaseModel):
    prefix: str
    suffix: str = ""
    language: str = "python"
    max_tokens: int = MAX_TOKENS_COMPLETE

@router.post("/completions")
async def complete(req: CompletionRequest):
    prompt = build_completion_prompt(req.prefix, req.suffix, req.language)
    llm = get_model()
    with get_lock():
        result = llm(
            prompt,
            max_tokens=req.max_tokens,
            temperature=0.1,
            stop=["<|fim_pad|>", "<|endoftext|>", "\n\n\n"],
            echo=False
        )
    return {"completion": result["choices"][0]["text"]}
```

**6. Crear `routers/analysis.py`**
```python
# ~/silo/backend/routers/analysis.py
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import json
from model import get_model, get_lock
from prompts import build_analysis_prompt

router = APIRouter()

class AnalysisRequest(BaseModel):
    code: str
    filename: str

@router.post("/analyze")
async def analyze(req: AnalysisRequest):
    messages = build_analysis_prompt(req.code, req.filename)

    def generate():
        llm = get_model()
        with get_lock():
            stream = llm.create_chat_completion(
                messages=messages,
                max_tokens=2048,
                stream=True,
                temperature=0.1
            )
            for chunk in stream:
                delta = chunk["choices"][0].get("delta", {})
                if "content" in delta and delta["content"]:
                    data = json.dumps({"token": delta["content"]})
                    yield f"data: {data}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
```

**7. Crear `main.py`**
```python
# ~/silo/backend/main.py
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from model import get_model
from routers import chat, completions, analysis

@asynccontextmanager
async def lifespan(app: FastAPI):
    print("Loading Silo model...")
    get_model()
    print("Silo ready.")
    yield

app = FastAPI(title="Silo Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["vscode-webview://*", "http://localhost:*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(chat.router)
app.include_router(completions.router)
app.include_router(analysis.router)

@app.get("/health")
async def health():
    return {"status": "ok", "model": "Qwen2.5-Coder-32B"}
```

**8. Arrancar el backend**
```bash
cd ~/silo/backend
source .venv/bin/activate
uvicorn main:app --host 127.0.0.1 --port 8942 --workers 1
```

**9. Verificar el backend**
```bash
# En otra terminal
curl http://localhost:8942/health

curl -X POST http://localhost:8942/completions \
  -H "Content-Type: application/json" \
  -d '{"prefix": "def fibonacci(n):\n    ", "language": "python"}'
```
> **Criterio de éxito:** `/health` devuelve `{"status":"ok"}` y `/completions` devuelve código coherente.

---

## FASE 3 — Extensión VS Code · Chat Panel

**Qué se hace:** Crear la extensión TypeScript con un panel Webview que actúe como interfaz de chat conectada al backend Silo vía SSE.

### Estructura de archivos
```
~/silo/extension/
├── package.json
├── tsconfig.json
├── src/
│   ├── extension.ts
│   ├── backend.ts
│   ├── contextCollector.ts
│   └── panels/
│       └── ChatPanel.ts
└── media/
    └── chat.html
```

### Pasos

**1. Scaffolding de la extensión**
```bash
npm install -g @vscode/vsce yo generator-code
cd ~/silo
yo code
# Seleccionar: New Extension (TypeScript)
# Name: silo
# Identifier: silo
# Mover los archivos generados a ~/silo/extension/
```

**2. Reemplazar `package.json`**
```json
{
  "name": "silo",
  "displayName": "Silo — Local AI Coding Assistant",
  "description": "Claude Code equivalent powered by local LLM (Qwen2.5-Coder)",
  "version": "1.0.0",
  "publisher": "silo-local",
  "engines": { "vscode": "^1.90.0" },
  "categories": ["AI", "Programming Languages", "Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      { "command": "silo.openChat", "title": "Silo: Open Chat" },
      { "command": "silo.analyzeFile", "title": "Silo: Analyze Current File" },
      { "command": "silo.refactorSelection", "title": "Silo: Refactor Selection" },
      { "command": "silo.explainSelection", "title": "Silo: Explain Selection" }
    ],
    "menus": {
      "editor/context": [
        { "command": "silo.refactorSelection", "when": "editorHasSelection", "group": "silo" },
        { "command": "silo.explainSelection", "when": "editorHasSelection", "group": "silo" }
      ]
    },
    "configuration": {
      "title": "Silo",
      "properties": {
        "silo.backendUrl": {
          "type": "string",
          "default": "http://127.0.0.1:8942",
          "description": "Silo backend URL"
        },
        "silo.contextFiles": {
          "type": "number",
          "default": 5,
          "description": "Number of open files to include in context"
        }
      }
    }
  },
  "scripts": {
    "compile": "tsc -p ./",
    "watch": "tsc -watch -p ./",
    "package": "vsce package"
  },
  "devDependencies": {
    "@types/vscode": "^1.90.0",
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0",
    "@vscode/vsce": "^2.26.0"
  }
}
```

**3. Crear `src/backend.ts`**
```typescript
// src/backend.ts
import * as vscode from 'vscode';

function getBackendUrl(): string {
  return vscode.workspace.getConfiguration('silo').get('backendUrl', 'http://127.0.0.1:8942');
}

export async function streamChat(
  message: string,
  history: { role: string; content: string }[],
  fileContext: string,
  onToken: (token: string) => void
): Promise<void> {
  const response = await fetch(`${getBackendUrl()}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history, file_context: fileContext }),
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
      } catch {}
    }
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
      } catch {}
    }
  }
}
```

**4. Crear `src/contextCollector.ts`**
```typescript
// src/contextCollector.ts
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
    .slice(0, maxFiles - 1);

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
```

**5. Crear `src/panels/ChatPanel.ts`**
```typescript
// src/panels/ChatPanel.ts
import * as vscode from 'vscode';
import { streamChat, streamAnalysis } from '../backend';
import { collectProjectContext, getActiveFileInfo } from '../contextCollector';

export class ChatPanel {
  static currentPanel: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private history: { role: string; content: string }[] = [];

  static createOrShow(extensionUri: vscode.Uri) {
    if (ChatPanel.currentPanel) {
      ChatPanel.currentPanel.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'siloChat', 'Silo Chat',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    ChatPanel.currentPanel = new ChatPanel(panel, extensionUri);
  }

  constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml();
    this.panel.onDidDispose(() => { ChatPanel.currentPanel = undefined; });
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'chat') await this.handleChat(msg.text);
      if (msg.type === 'analyze') await this.handleAnalyze();
      if (msg.type === 'clear') this.history = [];
    });
  }

  private async handleChat(text: string) {
    const fileContext = await collectProjectContext();
    this.history.push({ role: 'user', content: text });
    this.panel.webview.postMessage({ type: 'start', role: 'assistant' });
    let full = '';
    await streamChat(text, this.history.slice(0, -1), fileContext, (token) => {
      full += token;
      this.panel.webview.postMessage({ type: 'token', token });
    });
    this.history.push({ role: 'assistant', content: full });
    this.panel.webview.postMessage({ type: 'done' });
  }

  private async handleAnalyze() {
    const info = getActiveFileInfo();
    if (!info) return;
    this.panel.webview.postMessage({ type: 'start', role: 'assistant', label: `Analyzing ${info.filename}...` });
    let full = '';
    await streamAnalysis(info.code, info.filename, (token) => {
      full += token;
      this.panel.webview.postMessage({ type: 'token', token });
    });
    this.history.push({ role: 'assistant', content: full });
    this.panel.webview.postMessage({ type: 'done' });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Silo</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground);
         font-family: var(--vscode-font-family); height: 100vh; display: flex; flex-direction: column; }
  #messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .msg { padding: 10px 14px; border-radius: 8px; max-width: 90%; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
  .user { background: var(--vscode-button-background); color: var(--vscode-button-foreground); align-self: flex-end; }
  .assistant { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); align-self: flex-start; }
  #toolbar { display: flex; gap: 6px; padding: 8px 12px; border-top: 1px solid var(--vscode-widget-border); }
  #input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
           border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 8px; resize: none; font-family: inherit; font-size: 13px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
           border: none; border-radius: 4px; padding: 8px 14px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  .cursor::after { content: '▌'; animation: blink 1s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  pre { background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; overflow-x: auto; margin: 4px 0; }
  code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
</style>
</head>
<body>
<div id="messages"></div>
<div id="toolbar">
  <textarea id="input" rows="3" placeholder="Ask Silo anything about your code..."></textarea>
  <div style="display:flex;flex-direction:column;gap:6px">
    <button onclick="send()">Send</button>
    <button onclick="analyze()">Analyze</button>
    <button onclick="clear()">Clear</button>
  </div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const input = document.getElementById('input');
  let currentMsg = null;

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  function send() {
    const text = input.value.trim();
    if (!text) return;
    addMessage('user', text);
    input.value = '';
    vscode.postMessage({ type: 'chat', text });
  }

  function analyze() { vscode.postMessage({ type: 'analyze' }); }
  function clear() { messages.innerHTML = ''; vscode.postMessage({ type: 'clear' }); }

  function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.type === 'start') {
      currentMsg = addMessage('assistant', msg.label || '');
      currentMsg.classList.add('cursor');
    } else if (msg.type === 'token' && currentMsg) {
      currentMsg.textContent += msg.token;
      messages.scrollTop = messages.scrollHeight;
    } else if (msg.type === 'done' && currentMsg) {
      currentMsg.classList.remove('cursor');
      currentMsg = null;
    }
  });
</script>
</body>
</html>`;
  }
}
```

**6. Crear `src/extension.ts`**
```typescript
// src/extension.ts
import * as vscode from 'vscode';
import { ChatPanel } from './panels/ChatPanel';
import { getActiveFileInfo, getSelectedText } from './contextCollector';
import { streamChat } from './backend';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('silo.openChat', () => {
      ChatPanel.createOrShow(context.extensionUri);
    }),

    vscode.commands.registerCommand('silo.analyzeFile', () => {
      ChatPanel.createOrShow(context.extensionUri);
      setTimeout(() => ChatPanel.currentPanel?.['handleAnalyze']?.(), 500);
    }),

    vscode.commands.registerCommand('silo.refactorSelection', async () => {
      const selected = getSelectedText();
      if (!selected) return vscode.window.showWarningMessage('Silo: No text selected');
      ChatPanel.createOrShow(context.extensionUri);
    }),

    vscode.commands.registerCommand('silo.explainSelection', async () => {
      const selected = getSelectedText();
      if (!selected) return vscode.window.showWarningMessage('Silo: No text selected');
      ChatPanel.createOrShow(context.extensionUri);
    })
  );
}

export function deactivate() {}
```

**7. Compilar la extensión**
```bash
cd ~/silo/extension
npm install
npm run compile
```

**8. Instalar en VS Code para pruebas**
```bash
# Abrir VS Code en la carpeta de la extensión
code ~/silo/extension

# En VS Code: presionar F5 para lanzar Extension Development Host
# O instalar manualmente:
cd ~/silo/extension
vsce package
code --install-extension silo-1.0.0.vsix
```
> **Criterio de éxito:** El comando `Silo: Open Chat` abre el panel y responde mensajes del usuario.

---

## FASE 4 — Inline Completions

**Qué se hace:** Registrar un `InlineCompletionItemProvider` que solicita completions al backend cuando el usuario hace pausa al escribir.

### Pasos

**1. Crear `src/completionProvider.ts`**
```typescript
// src/completionProvider.ts
import * as vscode from 'vscode';
import { getCompletion } from './backend';

export class SiloCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: NodeJS.Timeout | undefined;

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
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
```

**2. Registrar el provider en `extension.ts`**
```typescript
// Añadir dentro de la función activate():
import { SiloCompletionProvider } from './completionProvider';

// Dentro de activate():
context.subscriptions.push(
  vscode.languages.registerInlineCompletionItemProvider(
    { pattern: '**' },
    new SiloCompletionProvider()
  )
);
```

**3. Recompilar**
```bash
cd ~/silo/extension
npm run compile
```
> **Criterio de éxito:** Al escribir código, aparecen sugerencias inline en gris que se aceptan con Tab.

---

## FASE 5 — Funcionalidades avanzadas

**Qué se hace:** Añadir refactoring inline (aplica cambios directamente en el editor) y el comando de explicación de selección con resultado en el chat.

### Pasos

**1. Añadir endpoint de refactoring en el backend**

Añadir a `~/silo/backend/routers/chat.py`:
```python
class RefactorRequest(BaseModel):
    code: str
    instruction: str
    language: str = "python"

@router.post("/refactor")
async def refactor(req: RefactorRequest):
    messages = [
        {"role": "system", "content": "You are an expert code refactoring assistant. Return ONLY the refactored code, no explanation, no markdown fences."},
        {"role": "user", "content": f"Refactor the following {req.language} code according to this instruction: {req.instruction}\n\nCode:\n{req.code}"}
    ]

    def generate():
        llm = get_model()
        with get_lock():
            stream = llm.create_chat_completion(
                messages=messages, max_tokens=2048, stream=True, temperature=0.1
            )
            for chunk in stream:
                delta = chunk["choices"][0].get("delta", {})
                if "content" in delta and delta["content"]:
                    yield f"data: {json.dumps({'token': delta['content']})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
```

**2. Añadir función de refactor en `backend.ts`**
```typescript
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
      try { const p = JSON.parse(data); if (p.token) onToken(p.token); } catch {}
    }
  }
}
```

**3. Completar los comandos de refactor/explain en `extension.ts`**
```typescript
// Reemplazar el comando silo.refactorSelection:
vscode.commands.registerCommand('silo.refactorSelection', async () => {
  const editor = vscode.window.activeTextEditor;
  const selected = getSelectedText();
  if (!selected || !editor) return vscode.window.showWarningMessage('Silo: No text selected');

  const instruction = await vscode.window.showInputBox({
    prompt: 'Refactoring instruction',
    placeHolder: 'e.g. Convert to async/await, add type hints, optimize performance...'
  });
  if (!instruction) return;

  let refactored = '';
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Silo: Refactoring...', cancellable: false },
    async () => {
      await streamRefactor(selected, instruction, editor.document.languageId, t => refactored += t);
    }
  );

  await editor.edit(eb => eb.replace(editor.selection, refactored.trim()));
}),

// Reemplazar el comando silo.explainSelection:
vscode.commands.registerCommand('silo.explainSelection', async () => {
  const selected = getSelectedText();
  if (!selected) return vscode.window.showWarningMessage('Silo: No text selected');
  ChatPanel.createOrShow(context.extensionUri);
  await new Promise(r => setTimeout(r, 300));
  // Inyectar mensaje al chat panel
  ChatPanel.currentPanel?.sendExternalMessage(`Explain this code:\n\`\`\`\n${selected}\n\`\`\``);
}),
```

**4. Añadir `sendExternalMessage` a `ChatPanel.ts`**
```typescript
// Añadir dentro de la clase ChatPanel:
public async sendExternalMessage(text: string) {
  await this.handleChat(text);
}
```

**5. Recompilar y reempaquetar**
```bash
cd ~/silo/extension
npm run compile
```
> **Criterio de éxito:** Seleccionar código → clic derecho → "Silo: Refactor Selection" aplica cambios directamente en el editor.

---

## FASE 6 — Optimización y empaquetado

**Qué se hace:** Optimizar el rendimiento del backend para la RTX 5080, crear scripts de inicio automático, y generar el `.vsix` final listo para distribución o publicación en el Marketplace.

### Pasos

**1. Optimizar parámetros del modelo para RTX 5080**

Actualizar `~/silo/backend/config.py`:
```python
# RTX 5080: 16GB VRAM, arquitectura Blackwell
N_GPU_LAYERS = -1      # Todas las capas en GPU
N_CTX = 16384          # 16K contexto
N_BATCH = 1024         # Batch mayor = mejor throughput
N_THREADS = 8          # Threads CPU para prefill
N_THREADS_BATCH = 8
FLASH_ATTN = True
USE_MMAP = True
USE_MLOCK = False      # No bloquear en RAM (tenemos 64GB, no es necesario)
```

Actualizar la inicialización en `model.py`:
```python
_llm = Llama(
    model_path=MODEL_PATH,
    n_gpu_layers=N_GPU_LAYERS,
    n_ctx=N_CTX,
    n_batch=N_BATCH,
    n_threads=N_THREADS,
    n_threads_batch=N_THREADS_BATCH,
    flash_attn=FLASH_ATTN,
    use_mmap=USE_MMAP,
    use_mlock=USE_MLOCK,
    verbose=False,
    chat_format="chatml"
)
```

**2. Script de inicio del backend**
```bash
cat > ~/silo/start-backend.sh << 'EOF'
#!/bin/bash
cd ~/silo/backend
source .venv/bin/activate
export CUDA_VISIBLE_DEVICES=0
export GGML_CUDA_NO_PINNED=1
uvicorn main:app \
  --host 127.0.0.1 \
  --port 8942 \
  --workers 1 \
  --loop uvloop \
  --log-level warning
EOF
chmod +x ~/silo/start-backend.sh
```

**3. Servicio systemd (autostart al iniciar sesión)**
```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/silo-backend.service << EOF
[Unit]
Description=Silo LLM Backend
After=network.target

[Service]
Type=simple
ExecStart=/bin/bash %h/silo/start-backend.sh
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user enable silo-backend
systemctl --user start silo-backend
systemctl --user status silo-backend
```

**4. Preparar la extensión para publicación**

Crear `~/silo/extension/.vscodeignore`:
```
.vscode/**
node_modules/**
src/**
tsconfig.json
.gitignore
```

Crear `~/silo/extension/README.md`:
```markdown
# Silo — Local AI Coding Assistant

A fully local Claude Code equivalent powered by Qwen2.5-Coder-32B.

## Requirements
- Silo backend running at `http://127.0.0.1:8942`
- RTX GPU with 16GB+ VRAM recommended

## Features
- **Chat panel** with full project context
- **Inline completions** (Tab to accept)
- **File analysis** with bug detection and suggestions
- **Inline refactoring** — applies changes directly in editor
- **Code explanation** for any selected text

## Setup
1. Start the backend: `~/silo/start-backend.sh`
2. Open VS Code and run `Silo: Open Chat`
```

**5. Generar el `.vsix`**
```bash
cd ~/silo/extension
npm run compile
vsce package
# Genera: silo-1.0.0.vsix
```

**6. Instalar la versión final**
```bash
code --install-extension ~/silo/extension/silo-1.0.0.vsix
```

**7. (Opcional) Publicar en VS Code Marketplace**
```bash
# Crear cuenta en https://marketplace.visualstudio.com/manage
# Generar Personal Access Token en dev.azure.com
vsce login silo-local
vsce publish
```
> **Criterio de éxito final:** La extensión instalada desde el `.vsix` funciona completamente: chat, completions inline, análisis, refactoring, sin ningún error en la consola de VS Code.

---

## Resumen de comandos frecuentes

```bash
# Iniciar backend manualmente
~/silo/start-backend.sh

# Verificar estado
curl http://localhost:8942/health

# Ver logs del servicio systemd
journalctl --user -u silo-backend -f

# Recompilar extensión tras cambios
cd ~/silo/extension && npm run compile

# Reempaquetar
cd ~/silo/extension && vsce package && code --install-extension silo-1.0.0.vsix