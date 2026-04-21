from fastapi import APIRouter
from fastapi.responses import StreamingResponse, JSONResponse
from pydantic import BaseModel
import json
import httpx
import subprocess
from prompts import build_chat_messages
import config
from tools import filter_tools_for_mode, execute_tool, execute_tool_async
from memory import load_memory
from summarize import summarize_history, should_compact
from providers import stream_cloud

router = APIRouter()


ASYNC_TOOLS = {"web_search", "web_fetch"}


class ChatRequest(BaseModel):
    message: str
    history: list[dict] = []
    file_context: str = ""
    turbo: bool = False
    workspace: str = ""
    mode: str = "auto"          # ask | plan | auto (edit)
    diagnostics: str = ""
    git_diff: str = ""
    # Cloud provider routing — when provider is set, skip Ollama + tools entirely
    provider: str = ""          # "" | openai | anthropic | gemini
    remote_model: str = ""      # model id for the cloud provider (e.g. gpt-4o)
    api_key: str = ""           # user-supplied API key


def _stream_ollama(messages: list[dict], turbo: bool, timeout: float = 300.0):
    """Simple streaming without tool use (refactor/analysis)."""
    async def generate():
        opts = config.get_options(turbo)
        try:
            async with httpx.AsyncClient(base_url=config.OLLAMA_BASE_URL, timeout=timeout) as client:
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
    return generate()


def _agentic_stream(messages: list[dict], turbo: bool, workspace: str, mode: str, timeout: float = 300.0):
    """
    Agentic loop with tool use.
    Streams tool_call / tool_result / todos / token events.
    Honors mode: plan mode restricts tools to read-only.
    """
    async def generate():
        opts = config.get_options(turbo)
        current_messages = list(messages)
        tools = filter_tools_for_mode(mode)

        try:
            async with httpx.AsyncClient(base_url=config.OLLAMA_BASE_URL, timeout=timeout) as client:
                for _round in range(25):
                    resp = await client.post("/api/chat", json={
                        "model": config.MODEL_NAME,
                        "messages": current_messages,
                        "stream": False,
                        "options": opts,
                        "tools": tools,
                    })
                    resp.raise_for_status()
                    data = resp.json()

                    if err := data.get("error"):
                        yield f"data: {json.dumps({'error': err})}\n\n"
                        return

                    msg = data.get("message", {})
                    tool_calls = msg.get("tool_calls") or []
                    content = msg.get("content") or ""

                    if not tool_calls:
                        for i in range(0, len(content), 3):
                            yield f"data: {json.dumps({'token': content[i:i+3]})}\n\n"
                        return

                    if content:
                        for i in range(0, len(content), 3):
                            yield f"data: {json.dumps({'token': content[i:i+3]})}\n\n"

                    current_messages.append(msg)

                    for tc in tool_calls:
                        fn = tc.get("function", {})
                        fn_name = fn.get("name", "")
                        fn_args = fn.get("arguments", {})
                        if isinstance(fn_args, str):
                            try:
                                fn_args = json.loads(fn_args)
                            except Exception:
                                fn_args = {}

                        yield f"data: {json.dumps({'tool_call': fn_name, 'args': fn_args})}\n\n"

                        if fn_name in ASYNC_TOOLS:
                            result = await execute_tool_async(fn_name, fn_args, workspace)
                        else:
                            result = execute_tool(fn_name, fn_args, workspace)

                        # Special: todo_write returns a marker that we forward as a structured event
                        if isinstance(result, str) and result.startswith("__TODOS__"):
                            try:
                                todos = json.loads(result[len("__TODOS__"):])
                            except Exception:
                                todos = []
                            yield f"data: {json.dumps({'todos': todos})}\n\n"
                            current_messages.append({
                                "role": "tool",
                                "content": f"(todo list updated — {len(todos)} items)"
                            })
                            # Still emit a short tool_result so the UI can log the call
                            yield f"data: {json.dumps({'tool_result': fn_name, 'result': f'{len(todos)} todo(s) set', 'success': True})}\n\n"
                            continue

                        yield f"data: {json.dumps({'tool_result': fn_name, 'result': result[:1000], 'success': not result.startswith('Error:')})}\n\n"

                        current_messages.append({
                            "role": "tool",
                            "content": result
                        })

        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return generate()


@router.post("/chat")
async def chat(req: ChatRequest):
    history = req.history or []

    # Auto-compact long conversations before sending
    if should_compact(history):
        summary = await summarize_history(history)
        history = [{
            "role": "system",
            "content": f"## Prior conversation (compacted)\n\n{summary}"
        }]

    memory = load_memory(req.workspace)

    messages = build_chat_messages(
        history=history,
        user_message=req.message,
        file_context=req.file_context,
        mode=req.mode,
        memory=memory,
        diagnostics=req.diagnostics,
        git_diff=req.git_diff,
    )

    # Cloud provider: stream directly from OpenAI / Anthropic / Gemini.
    if req.provider:
        return StreamingResponse(
            stream_cloud(req.provider, messages, req.remote_model, req.api_key),
            media_type="text/event-stream"
        )

    return StreamingResponse(
        _agentic_stream(messages, req.turbo, req.workspace, req.mode),
        media_type="text/event-stream"
    )


class CompactRequest(BaseModel):
    history: list[dict] = []


@router.post("/compact")
async def compact(req: CompactRequest):
    summary = await summarize_history(req.history or [])
    return JSONResponse({"summary": summary})


class RefactorRequest(BaseModel):
    code: str
    instruction: str
    language: str = "python"
    turbo: bool = False


@router.post("/refactor")
async def refactor(req: RefactorRequest):
    messages = [
        {"role": "system", "content": "You are an expert code refactoring assistant. Return ONLY the refactored code, no explanation, no markdown fences."},
        {"role": "user", "content": f"Refactor the following {req.language} code according to this instruction: {req.instruction}\n\nCode:\n{req.code}"},
    ]
    return StreamingResponse(_stream_ollama(messages, req.turbo, timeout=300.0), media_type="text/event-stream")


class ReviewRequest(BaseModel):
    workspace: str = ""
    base_ref: str = "HEAD~1"  # diff target; default = last commit
    provider: str = ""
    remote_model: str = ""
    api_key: str = ""
    turbo: bool = False


@router.post("/review")
async def review(req: ReviewRequest):
    """Stream a PR/diff code review."""
    cwd = req.workspace if req.workspace and req.workspace != "__global__" else None
    diff = ""
    if cwd:
        try:
            result = subprocess.run(
                ["git", "diff", req.base_ref or "HEAD~1"],
                cwd=cwd, capture_output=True, text=True, timeout=15,
                encoding="utf-8", errors="replace"
            )
            diff = (result.stdout or "").strip()[:12000]
        except Exception:
            pass

    if not diff:
        diff = "(no diff available — make sure you have commits or changes staged)"

    messages = [
        {
            "role": "system",
            "content": (
                "You are an expert code reviewer. Review the git diff below. "
                "Give structured, actionable feedback: bugs, security issues, "
                "performance concerns, style suggestions. Be specific — cite line numbers "
                "or code snippets. Format with Markdown headers."
            )
        },
        {"role": "user", "content": f"Please review this diff:\n\n```diff\n{diff}\n```"}
    ]

    if req.provider and req.api_key:
        return StreamingResponse(
            stream_cloud(req.provider, messages, req.remote_model, req.api_key),
            media_type="text/event-stream"
        )
    return StreamingResponse(_stream_ollama(messages, req.turbo, timeout=300.0), media_type="text/event-stream")
