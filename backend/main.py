from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from model import check_model
from config import MODEL_NAME
from routers import chat, completions, analysis


@asynccontextmanager
async def lifespan(app: FastAPI):
    ok = await check_model()
    if ok:
        print(f"Silo ready — model: {MODEL_NAME}")
    else:
        print(f"WARNING: model '{MODEL_NAME}' not found in Ollama.")
        print(f"Run: ollama pull {MODEL_NAME}")
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
    model_ok = await check_model()
    return {
        "status": "ok" if model_ok else "model_missing",
        "model": MODEL_NAME,
        "model_ready": model_ok
    }
