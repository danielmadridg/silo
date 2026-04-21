from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import json
import httpx
from prompts import build_analysis_prompt
import config

router = APIRouter()


class AnalysisRequest(BaseModel):
    code: str
    filename: str
    turbo: bool = False


@router.post("/analyze")
async def analyze(req: AnalysisRequest):
    messages = build_analysis_prompt(req.code, req.filename)
    opts = config.get_options(req.turbo)

    async def generate():
        try:
            async with httpx.AsyncClient(base_url=config.OLLAMA_BASE_URL, timeout=300.0) as client:
                async with client.stream("POST", "/api/chat", json={
                    "model": config.MODEL_NAME,
                    "messages": messages,
                    "stream": True,
                    "options": opts,
                }) as resp:
                    async for line in resp.aiter_lines():
                        if not line:
                            continue
                        try:
                            chunk = json.loads(line)
                            if err := chunk.get("error"):
                                yield f"data: {json.dumps({'error': err})}\n\n"
                                return
                            token = chunk.get("message", {}).get("content", "")
                            if token:
                                yield f"data: {json.dumps({'token': token})}\n\n"
                            if chunk.get("done"):
                                return
                        except Exception:
                            pass
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")
