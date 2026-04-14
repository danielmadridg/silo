from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
from pydantic import BaseModel
from model import check_model
import config
from routers import chat, completions, analysis


@asynccontextmanager
async def lifespan(app: FastAPI):
    ok = await check_model()
    if ok:
        print(f"Silo ready — model: {config.MODEL_NAME}")
    else:
        print(f"WARNING: model '{config.MODEL_NAME}' not found in Ollama.")
        print(f"Run: ollama pull {config.MODEL_NAME}")
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
        "model": config.MODEL_NAME,
        "model_ready": model_ok
    }


class ModelSwitch(BaseModel):
    model: str

@app.post("/model")
async def set_model(body: ModelSwitch):
    config.MODEL_NAME = body.model
    return {"model": config.MODEL_NAME}
