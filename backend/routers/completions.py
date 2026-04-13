from fastapi import APIRouter
from pydantic import BaseModel
import httpx
from prompts import build_completion_prompt
from config import MODEL_NAME, MAX_TOKENS_COMPLETE, OLLAMA_BASE_URL

router = APIRouter()


class CompletionRequest(BaseModel):
    prefix: str
    suffix: str = ""
    language: str = "python"
    max_tokens: int = MAX_TOKENS_COMPLETE


@router.post("/completions")
async def complete(req: CompletionRequest):
    prompt = build_completion_prompt(req.prefix, req.suffix, req.language)
    async with httpx.AsyncClient(base_url=OLLAMA_BASE_URL, timeout=60.0) as client:
        resp = await client.post("/api/generate", json={
            "model": MODEL_NAME,
            "prompt": prompt,
            "options": {
                "num_predict": req.max_tokens,
                "temperature": 0.1,
                "stop": ["<|fim_pad|>", "<|endoftext|>"],
            },
            "stream": False,
        })
    return {"completion": resp.json().get("response", "")}
