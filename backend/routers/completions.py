from fastapi import APIRouter
from pydantic import BaseModel
import httpx
from prompts import build_completion_prompt
import config

router = APIRouter()


class CompletionRequest(BaseModel):
    prefix: str
    suffix: str = ""
    language: str = "python"
    max_tokens: int = config.MAX_TOKENS_COMPLETE
    turbo: bool = False


@router.post("/completions")
async def complete(req: CompletionRequest):
    prompt = build_completion_prompt(req.prefix, req.suffix, req.language)
    opts = config.get_options(req.turbo)
    opts["num_predict"] = req.max_tokens
    opts["stop"] = ["<|fim_pad|>", "<|endoftext|>"]
    async with httpx.AsyncClient(base_url=config.OLLAMA_BASE_URL, timeout=60.0) as client:
        resp = await client.post("/api/generate", json={
            "model": config.MODEL_NAME,
            "prompt": prompt,
            "options": opts,
            "stream": False,
        })
    return {"completion": resp.json().get("response", "")}
