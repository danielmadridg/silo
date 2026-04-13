from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import json
import httpx
from prompts import build_analysis_prompt
from config import MODEL_NAME, OLLAMA_BASE_URL

router = APIRouter()


class AnalysisRequest(BaseModel):
    code: str
    filename: str


@router.post("/analyze")
async def analyze(req: AnalysisRequest):
    messages = build_analysis_prompt(req.code, req.filename)

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
