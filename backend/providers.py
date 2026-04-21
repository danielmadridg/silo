"""Cloud LLM providers: OpenAI, Anthropic, Google Gemini.

Streams plain text tokens over SSE-compatible generators.
Emits a `{"tokens": {"input": N, "output": N}}` event at the end of each response.
"""
import json
import httpx


def _err_sse(msg: str) -> str:
    return f"data: {json.dumps({'error': msg})}\n\n"


def _token_sse(tok: str) -> str:
    return f"data: {json.dumps({'token': tok})}\n\n"


def _tokens_sse(input_tokens: int, output_tokens: int) -> str:
    return f"data: {json.dumps({'tokens': {'input': input_tokens, 'output': output_tokens}})}\n\n"


async def _read_error(resp) -> str:
    try:
        body = await resp.aread()
        return body.decode(errors="replace")[:400]
    except Exception:
        return ""


# ── OpenAI Chat Completions (streaming) ───────────────────────────────────────
async def stream_openai(messages: list[dict], model: str, api_key: str, timeout: float = 180.0):
    url = "https://api.openai.com/v1/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model or "gpt-4o-mini",
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},  # enables usage in final chunk
    }
    input_tokens = 0
    output_tokens = 0
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code >= 400:
                    body = await _read_error(resp)
                    yield _err_sse(f"OpenAI {resp.status_code}: {body}")
                    return
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                        # Usage is in the final chunk when stream_options.include_usage=True
                        if chunk.get("usage"):
                            input_tokens = chunk["usage"].get("prompt_tokens", 0)
                            output_tokens = chunk["usage"].get("completion_tokens", 0)
                        token = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
                        if token:
                            yield _token_sse(token)
                    except Exception:
                        continue
    except Exception as e:
        yield _err_sse(f"OpenAI error: {e}")
        return
    if input_tokens or output_tokens:
        yield _tokens_sse(input_tokens, output_tokens)


# ── Anthropic Messages API (streaming) ────────────────────────────────────────
async def stream_anthropic(messages: list[dict], model: str, api_key: str, timeout: float = 180.0):
    system_parts = [m["content"] for m in messages if m.get("role") == "system" and m.get("content")]
    system_text = "\n\n".join(system_parts).strip()
    convo = [m for m in messages if m.get("role") in ("user", "assistant") and m.get("content")]
    if not convo or convo[0]["role"] != "user":
        convo.insert(0, {"role": "user", "content": "."})

    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    payload: dict = {
        "model": model or "claude-sonnet-4-5",
        "max_tokens": 4096,
        "stream": True,
        "messages": convo,
    }
    if system_text:
        payload["system"] = system_text

    input_tokens = 0
    output_tokens = 0
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as resp:
                if resp.status_code >= 400:
                    body = await _read_error(resp)
                    yield _err_sse(f"Anthropic {resp.status_code}: {body}")
                    return
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    if not data:
                        continue
                    try:
                        chunk = json.loads(data)
                        ctype = chunk.get("type")
                        if ctype == "message_start":
                            usage = chunk.get("message", {}).get("usage", {})
                            input_tokens = usage.get("input_tokens", 0)
                        elif ctype == "message_delta":
                            usage = chunk.get("usage", {})
                            output_tokens = usage.get("output_tokens", 0)
                        elif ctype == "content_block_delta":
                            token = chunk.get("delta", {}).get("text", "")
                            if token:
                                yield _token_sse(token)
                        elif ctype == "message_stop":
                            break
                    except Exception:
                        continue
    except Exception as e:
        yield _err_sse(f"Anthropic error: {e}")
        return
    if input_tokens or output_tokens:
        yield _tokens_sse(input_tokens, output_tokens)


# ── Google Gemini (streamGenerateContent) ─────────────────────────────────────
async def stream_gemini(messages: list[dict], model: str, api_key: str, timeout: float = 180.0):
    system_parts = [m["content"] for m in messages if m.get("role") == "system" and m.get("content")]
    system_text = "\n\n".join(system_parts).strip()

    contents = []
    for m in messages:
        role = m.get("role")
        if role not in ("user", "assistant"):
            continue
        txt = m.get("content") or ""
        if not txt:
            continue
        contents.append({
            "role": "user" if role == "user" else "model",
            "parts": [{"text": txt}],
        })
    if not contents:
        contents = [{"role": "user", "parts": [{"text": "."}]}]

    model_id = model or "gemini-2.0-flash"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:streamGenerateContent?alt=sse&key={api_key}"
    payload: dict = {"contents": contents}
    if system_text:
        payload["systemInstruction"] = {"parts": [{"text": system_text}]}

    input_tokens = 0
    output_tokens = 0
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream("POST", url, headers={"Content-Type": "application/json"}, json=payload) as resp:
                if resp.status_code >= 400:
                    body = await _read_error(resp)
                    yield _err_sse(f"Gemini {resp.status_code}: {body}")
                    return
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data: "):
                        continue
                    data = line[6:].strip()
                    if not data:
                        continue
                    try:
                        chunk = json.loads(data)
                        # usageMetadata is in the final chunk
                        usage = chunk.get("usageMetadata")
                        if usage:
                            input_tokens = usage.get("promptTokenCount", 0)
                            output_tokens = usage.get("candidatesTokenCount", 0)
                        cand = (chunk.get("candidates") or [{}])[0]
                        parts = (cand.get("content") or {}).get("parts") or []
                        for p in parts:
                            token = p.get("text", "")
                            if token:
                                yield _token_sse(token)
                    except Exception:
                        continue
    except Exception as e:
        yield _err_sse(f"Gemini error: {e}")
        return
    if input_tokens or output_tokens:
        yield _tokens_sse(input_tokens, output_tokens)


async def stream_cloud(provider: str, messages: list[dict], model: str, api_key: str):
    """Dispatcher: yields SSE-formatted strings, ending with [DONE]."""
    p = (provider or "").lower()
    if not api_key:
        yield _err_sse("Missing API key for cloud provider.")
        yield "data: [DONE]\n\n"
        return
    if p == "openai":
        async for chunk in stream_openai(messages, model, api_key):
            yield chunk
    elif p in ("anthropic", "claude"):
        async for chunk in stream_anthropic(messages, model, api_key):
            yield chunk
    elif p in ("gemini", "google"):
        async for chunk in stream_gemini(messages, model, api_key):
            yield chunk
    else:
        yield _err_sse(f"Unknown provider: {provider}")
    yield "data: [DONE]\n\n"
