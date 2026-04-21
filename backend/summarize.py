"""Context compaction: summarize long conversations so the model stays sharp."""
import httpx
import config


COMPACT_AFTER = 30  # messages — auto-compact when history exceeds this


async def summarize_history(history: list[dict]) -> str:
    """Ask the model to produce a terse bullet summary of the conversation."""
    if not history:
        return ""
    convo = "\n".join(
        f"{m.get('role','?').upper()}: {(m.get('content') or '')[:500]}"
        for m in history if m.get('role') in ('user', 'assistant')
    )
    prompt = (
        "Summarize this coding conversation as dense bullet points. "
        "Keep: user goals, decisions, file paths touched, open problems. "
        "Drop: pleasantries, tool output, anything stale.\n\n"
        f"{convo}"
    )
    try:
        async with httpx.AsyncClient(base_url=config.OLLAMA_BASE_URL, timeout=120.0) as client:
            resp = await client.post("/api/chat", json={
                "model": config.MODEL_NAME,
                "messages": [
                    {"role": "system", "content": "You compress conversations. Output only bullets."},
                    {"role": "user", "content": prompt},
                ],
                "stream": False,
                "options": {**config.get_options(False), "num_predict": 1024},
            })
            data = resp.json()
            return data.get("message", {}).get("content", "").strip()
    except Exception as e:
        return f"(compaction failed: {e})"


def should_compact(history: list[dict]) -> bool:
    return len(history) >= COMPACT_AFTER
