import httpx
from config import OLLAMA_BASE_URL, MODEL_NAME

# Ollama OpenAI-compatible client
_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(base_url=OLLAMA_BASE_URL, timeout=300.0)
    return _client


async def check_model() -> bool:
    """Verify model is available in Ollama."""
    try:
        client = get_client()
        resp = await client.get("/api/tags")
        models = [m["name"] for m in resp.json().get("models", [])]
        return any(MODEL_NAME in m for m in models)
    except Exception:
        return False
