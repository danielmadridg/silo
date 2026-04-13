from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import json
import httpx
from model import get_client
from prompts import build_chat_messages
from config import MODEL_NAME, MAX_TOKENS_CHAT, OLLAMA_BASE_URL

router = APIRouter()


class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []
    file_context: str = ""


@router.post("/chat")
async def chat(req: ChatRequest):
    messages = build_chat_messages(req.history, req.message, req.file_context)

    async def generate():
        async with httpx.AsyncClient(base_url=OLLAMA_BASE_URL, timeout=300.0) as client:
            async with client.stream("POST", "/v1/chat/completions", json={
                "model": MODEL_NAME,
                "messages": messages,
                "max_tokens": MAX_TOKENS_CHAT,
                "temperature": 0.2,
                "top_p": 0.95,
                "stream": True,
            }) as resp:
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        yield "data: [DONE]\n\n"
                        return
                    try:
                        chunk = json.loads(data)
                        token = chunk["choices"][0].get("delta", {}).get("content", "")
                        if token:
                            yield f"data: {json.dumps({'token': token})}\n\n"
                    except Exception:
                        pass
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


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

    async def generate():
        async with httpx.AsyncClient(base_url=OLLAMA_BASE_URL, timeout=300.0) as client:
            async with client.stream("POST", "/v1/chat/completions", json={
                "model": MODEL_NAME,
                "messages": messages,
                "max_tokens": 2048,
                "temperature": 0.1,
                "stream": True,
            }) as resp:
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    data = line[6:]
                    if data == "[DONE]":
                        yield "data: [DONE]\n\n"
                        return
                    try:
                        chunk = json.loads(data)
                        token = chunk["choices"][0].get("delta", {}).get("content", "")
                        if token:
                            yield f"data: {json.dumps({'token': token})}\n\n"
                    except Exception:
                        pass
        yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
