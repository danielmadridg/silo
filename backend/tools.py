"""
Tool implementations for the Silo agentic loop.
Gives the AI full access to the filesystem and shell — like Claude Code.
"""
import os
import re
import glob as glob_module
import subprocess
import json
import asyncio
from typing import Any
from web import web_search, web_fetch


READ_ONLY_TOOLS = {
    "read_file", "list_directory", "search_files", "search_content",
    "web_search", "web_fetch", "todo_write",
    "git_status", "git_log_summary", "git_diff_tool",
}
WRITE_TOOLS = {
    "write_file", "edit_file", "multi_edit", "run_command",
    "execute_code", "git_commit", "git_create_branch", "git_checkout", "git_push",
}


def filter_tools_for_mode(mode: str) -> list:
    """Plan mode: only read-only tools. Ask/auto: all tools."""
    if mode == "plan":
        return [t for t in TOOL_SCHEMAS if t["function"]["name"] in READ_ONLY_TOOLS]
    return TOOL_SCHEMAS


# ── Tool schemas (Ollama function-calling format) ────────────────────────────
TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the full contents of a file. Always read a file before editing it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path (relative to workspace or absolute)"}
                },
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Create a new file or completely overwrite an existing file with the given content. Creates parent directories automatically.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path relative to workspace root"},
                    "content": {"type": "string", "description": "The full content to write"}
                },
                "required": ["path", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Edit a file by replacing old_string with new_string. The old_string must match exactly (including whitespace/indentation). Read the file first to get exact content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_string": {"type": "string", "description": "Exact text to find (must be unique in the file)"},
                    "new_string": {"type": "string", "description": "Replacement text"}
                },
                "required": ["path", "old_string", "new_string"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Execute a shell command. Use for: running tests, installing packages, building, or any CLI task not covered by a dedicated tool.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to run"},
                    "cwd": {"type": "string", "description": "Working directory (relative to workspace). Defaults to workspace root."}
                },
                "required": ["command"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "execute_code",
            "description": "Execute a Python or Node.js code snippet and return its stdout/stderr. Use for calculations, data processing, quick scripts, or testing logic.",
            "parameters": {
                "type": "object",
                "properties": {
                    "language": {"type": "string", "enum": ["python", "node"], "description": "python or node"},
                    "code": {"type": "string", "description": "Code to execute"},
                    "cwd": {"type": "string", "description": "Working directory (optional)"}
                },
                "required": ["language", "code"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": "List files and directories at a path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Directory path (relative to workspace). Defaults to workspace root."}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_files",
            "description": "Find files matching a glob pattern (e.g. '**/*.py', 'src/**/*.ts').",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern"},
                    "path": {"type": "string", "description": "Base directory to search from"}
                },
                "required": ["pattern"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_content",
            "description": "Search for text or regex pattern within files (like grep). Returns file:line matches.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Text or regex to search for"},
                    "path": {"type": "string", "description": "Directory to search in"},
                    "file_pattern": {"type": "string", "description": "Only search files matching this glob (e.g. '*.py')"}
                },
                "required": ["pattern"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "multi_edit",
            "description": "Apply multiple edits to a single file atomically. Each edit is an old_string/new_string pair. All must match; if any fails, none are applied.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "edits": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "old_string": {"type": "string"},
                                "new_string": {"type": "string"}
                            },
                            "required": ["old_string", "new_string"]
                        }
                    }
                },
                "required": ["path", "edits"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web via DuckDuckGo. Use for recent docs, library versions, error messages, API references.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"}
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "Fetch a URL and return its text content (HTML tags stripped). Use for reading documentation pages, GitHub READMEs, API docs.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "Full URL including https://"}
                },
                "required": ["url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "todo_write",
            "description": "Maintain a visible task checklist for the user. Call this whenever you plan multi-step work or update progress. Pass the full list each time — replaces previous list.",
            "parameters": {
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "text": {"type": "string"},
                                "status": {"type": "string", "enum": ["pending", "in_progress", "done"]}
                            },
                            "required": ["text", "status"]
                        }
                    }
                },
                "required": ["todos"]
            }
        }
    },
    # ── Git tools ────────────────────────────────────────────────────────────
    {
        "type": "function",
        "function": {
            "name": "git_status",
            "description": "Show working tree status — staged, unstaged, and untracked files.",
            "parameters": {"type": "object", "properties": {}}
        }
    },
    {
        "type": "function",
        "function": {
            "name": "git_log_summary",
            "description": "Show the last N commits in one-line format.",
            "parameters": {
                "type": "object",
                "properties": {
                    "n": {"type": "integer", "description": "Number of commits (default 10)"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "git_diff_tool",
            "description": "Show git diff. Pass ref like 'HEAD', 'HEAD~1', or a branch name. Defaults to unstaged changes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "ref": {"type": "string", "description": "Git ref or branch to diff against (optional)"}
                }
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "git_commit",
            "description": "Stage all modified/new files and create a commit with the given message.",
            "parameters": {
                "type": "object",
                "properties": {
                    "message": {"type": "string", "description": "Commit message"}
                },
                "required": ["message"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "git_create_branch",
            "description": "Create a new git branch and switch to it.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Branch name"}
                },
                "required": ["name"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "git_checkout",
            "description": "Switch to an existing branch.",
            "parameters": {
                "type": "object",
                "properties": {
                    "branch": {"type": "string", "description": "Branch name to check out"}
                },
                "required": ["branch"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "git_push",
            "description": "Push the current branch to origin. Use --set-upstream if the branch is new.",
            "parameters": {
                "type": "object",
                "properties": {
                    "set_upstream": {"type": "boolean", "description": "Set upstream tracking branch (use for new branches)"}
                }
            }
        }
    },
]


# ── Path helper ───────────────────────────────────────────────────────────────
def _resolve(path: str, workspace: str) -> str:
    if os.path.isabs(path):
        return os.path.normpath(path)
    return os.path.normpath(os.path.join(workspace or ".", path))


def _run_git(args: list[str], workspace: str) -> str:
    """Run a git command in the workspace directory."""
    cwd = workspace if workspace and workspace != "__global__" else None
    if not cwd:
        return "Error: No workspace directory available"
    try:
        result = subprocess.run(
            ["git"] + args, cwd=cwd,
            capture_output=True, text=True, timeout=30,
            encoding="utf-8", errors="replace"
        )
        out = result.stdout.strip()
        err = result.stderr.strip()
        if result.returncode != 0 and err:
            return f"Error (exit {result.returncode}):\n{err}"
        return out or err or "(no output)"
    except subprocess.TimeoutExpired:
        return "Error: git command timed out"
    except FileNotFoundError:
        return "Error: git not found in PATH"
    except Exception as e:
        return f"Error: {e}"


# ── Tool implementations ──────────────────────────────────────────────────────
def tool_read_file(path: str, workspace: str) -> str:
    try:
        resolved = _resolve(path, workspace)
        if not os.path.exists(resolved):
            return f"Error: File not found: {resolved}"
        if os.path.isdir(resolved):
            return f"Error: {resolved} is a directory. Use list_directory instead."
        size = os.path.getsize(resolved)
        if size > 2_000_000:
            return f"Error: File too large ({size:,} bytes). Use search_content to find specific sections."
        with open(resolved, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        lines = content.count("\n") + 1
        return f"File: {resolved} ({lines} lines)\n```\n{content}\n```"
    except Exception as e:
        return f"Error: {e}"


def tool_write_file(path: str, content: str, workspace: str) -> str:
    try:
        resolved = _resolve(path, workspace)
        os.makedirs(os.path.dirname(resolved) or ".", exist_ok=True)
        existed = os.path.exists(resolved)
        with open(resolved, "w", encoding="utf-8") as f:
            f.write(content)
        action = "Updated" if existed else "Created"
        lines = content.count("\n") + 1
        return f"{action}: {resolved} ({lines} lines)"
    except Exception as e:
        return f"Error: {e}"


def tool_edit_file(path: str, old_string: str, new_string: str, workspace: str) -> str:
    try:
        resolved = _resolve(path, workspace)
        if not os.path.exists(resolved):
            return f"Error: File not found: {resolved}"
        with open(resolved, "r", encoding="utf-8") as f:
            content = f.read()
        count = content.count(old_string)
        if count == 0:
            stripped = old_string.strip()
            if stripped in content:
                return "Error: old_string not found (whitespace mismatch). Read the file first to get exact content with correct indentation."
            return "Error: old_string not found in file. Read the file first to get the exact current content."
        if count > 1:
            return f"Error: old_string matches {count} places. Add more surrounding context to make it unique."
        new_content = content.replace(old_string, new_string, 1)
        with open(resolved, "w", encoding="utf-8") as f:
            f.write(new_content)
        return f"Edited: {resolved}"
    except Exception as e:
        return f"Error: {e}"


def tool_run_command(command: str, cwd: str, workspace: str) -> str:
    try:
        working_dir = _resolve(cwd, workspace) if cwd else (workspace or None)
        result = subprocess.run(
            command, shell=True, cwd=working_dir,
            capture_output=True, text=True, timeout=60,
            encoding="utf-8", errors="replace"
        )
        parts = []
        if result.stdout.strip():
            parts.append(f"stdout:\n{result.stdout.strip()}")
        if result.stderr.strip():
            parts.append(f"stderr:\n{result.stderr.strip()}")
        parts.append(f"exit code: {result.returncode}")
        return "\n".join(parts)
    except subprocess.TimeoutExpired:
        return "Error: Command timed out after 60 seconds"
    except Exception as e:
        return f"Error: {e}"


def tool_execute_code(language: str, code: str, cwd: str, workspace: str) -> str:
    """Execute Python or Node code snippet, return output."""
    lang = (language or "").lower().strip()
    if lang not in ("python", "node", "nodejs", "javascript", "js"):
        return f"Error: Unsupported language '{language}'. Use 'python' or 'node'."

    working_dir = None
    if cwd:
        working_dir = _resolve(cwd, workspace)
    elif workspace and workspace != "__global__":
        working_dir = workspace

    if lang == "python":
        cmd = ["python", "-c", code]
    else:
        cmd = ["node", "-e", code]

    try:
        result = subprocess.run(
            cmd, cwd=working_dir,
            capture_output=True, text=True, timeout=30,
            encoding="utf-8", errors="replace"
        )
        parts = []
        if result.stdout.strip():
            parts.append(f"stdout:\n{result.stdout.strip()}")
        if result.stderr.strip():
            parts.append(f"stderr:\n{result.stderr.strip()}")
        parts.append(f"exit code: {result.returncode}")
        return "\n".join(parts) if parts else "(no output)"
    except subprocess.TimeoutExpired:
        return "Error: Code execution timed out (30s limit)"
    except FileNotFoundError:
        return f"Error: '{cmd[0]}' not found in PATH — is {language} installed?"
    except Exception as e:
        return f"Error: {e}"


def tool_list_directory(path: str, workspace: str) -> str:
    try:
        resolved = _resolve(path or ".", workspace)
        if not os.path.exists(resolved):
            return f"Error: Not found: {resolved}"
        entries = []
        for entry in sorted(os.scandir(resolved), key=lambda e: (not e.is_dir(), e.name.lower())):
            if entry.is_dir():
                entries.append(f"📁 {entry.name}/")
            else:
                sz = entry.stat().st_size
                entries.append(f"   {entry.name}  ({sz:,} B)")
        header = f"Directory: {resolved}\n"
        return header + ("\n".join(entries) if entries else "(empty)")
    except Exception as e:
        return f"Error: {e}"


def tool_search_files(pattern: str, path: str, workspace: str) -> str:
    try:
        base = _resolve(path or ".", workspace)
        full_pattern = os.path.join(base, pattern)
        matches = glob_module.glob(full_pattern, recursive=True)
        if not matches:
            return f"No files found matching: {pattern}"
        rel = [os.path.relpath(m, workspace) if workspace else m for m in sorted(matches)[:100]]
        return f"Found {len(matches)} file(s):\n" + "\n".join(rel)
    except Exception as e:
        return f"Error: {e}"


def tool_search_content(pattern: str, path: str, file_pattern: str, workspace: str) -> str:
    try:
        base = _resolve(path or ".", workspace)
        fp = file_pattern or "**/*"
        files = glob_module.glob(os.path.join(base, fp if "**" in fp else f"**/{fp}"), recursive=True)
        rx = re.compile(pattern, re.IGNORECASE)
        results = []
        for fpath in sorted(files)[:300]:
            if os.path.isdir(fpath):
                continue
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                    for i, line in enumerate(f, 1):
                        if rx.search(line):
                            rel = os.path.relpath(fpath, workspace) if workspace else fpath
                            results.append(f"{rel}:{i}: {line.rstrip()}")
                            if len(results) >= 80:
                                break
            except Exception:
                continue
            if len(results) >= 80:
                break
        if not results:
            return f"No matches for: {pattern}"
        return f"Found {len(results)} match(es):\n" + "\n".join(results)
    except Exception as e:
        return f"Error: {e}"


def tool_multi_edit(path: str, edits: list, workspace: str) -> str:
    try:
        resolved = _resolve(path, workspace)
        if not os.path.exists(resolved):
            return f"Error: File not found: {resolved}"
        with open(resolved, "r", encoding="utf-8") as f:
            content = f.read()
        original = content
        for i, e in enumerate(edits):
            old = e.get("old_string", "")
            new = e.get("new_string", "")
            c = content.count(old)
            if c == 0:
                return f"Error: edit {i+1}/{len(edits)}: old_string not found. No edits applied."
            if c > 1:
                return f"Error: edit {i+1}/{len(edits)}: old_string matches {c} places (need unique). No edits applied."
            content = content.replace(old, new, 1)
        if content == original:
            return f"No changes: {resolved}"
        with open(resolved, "w", encoding="utf-8") as f:
            f.write(content)
        return f"Edited {len(edits)} sections in: {resolved}"
    except Exception as e:
        return f"Error: {e}"


async def tool_web_search(query: str) -> str:
    return await web_search(query)


async def tool_web_fetch(url: str) -> str:
    return await web_fetch(url)


def tool_todo_write(todos: list) -> str:
    try:
        clean = []
        for t in todos:
            text = (t.get("text") or "").strip()
            status = t.get("status", "pending")
            if status not in ("pending", "in_progress", "done"):
                status = "pending"
            if text:
                clean.append({"text": text, "status": status})
        payload = json.dumps(clean)
        return f"__TODOS__{payload}"
    except Exception as e:
        return f"Error: {e}"


# ── Git tool implementations ──────────────────────────────────────────────────
def tool_git_status(workspace: str) -> str:
    return _run_git(["status", "--short", "--branch"], workspace)


def tool_git_log_summary(n: int, workspace: str) -> str:
    count = max(1, min(int(n or 10), 50))
    return _run_git(["log", f"--oneline", f"-{count}"], workspace)


def tool_git_diff_tool(ref: str, workspace: str) -> str:
    args = ["diff"]
    if ref:
        args.append(ref)
    result = _run_git(args, workspace)
    return result[:8000] if len(result) > 8000 else result


def tool_git_commit(message: str, workspace: str) -> str:
    if not message or not message.strip():
        return "Error: Commit message required"
    add = _run_git(["add", "-A"], workspace)
    if add.startswith("Error"):
        return add
    result = _run_git(["commit", "-m", message.strip()], workspace)
    return result


def tool_git_create_branch(name: str, workspace: str) -> str:
    if not name or not name.strip():
        return "Error: Branch name required"
    return _run_git(["checkout", "-b", name.strip()], workspace)


def tool_git_checkout(branch: str, workspace: str) -> str:
    if not branch or not branch.strip():
        return "Error: Branch name required"
    return _run_git(["checkout", branch.strip()], workspace)


def tool_git_push(set_upstream: bool, workspace: str) -> str:
    args = ["push"]
    if set_upstream:
        # Get current branch name
        branch_result = _run_git(["branch", "--show-current"], workspace)
        if not branch_result.startswith("Error"):
            args += ["--set-upstream", "origin", branch_result.strip()]
    return _run_git(args, workspace)


# ── Dispatcher ────────────────────────────────────────────────────────────────
def execute_tool(name: str, args: dict, workspace: str) -> str:
    ws = workspace or ""
    if name == "read_file":
        return tool_read_file(args.get("path", ""), ws)
    if name == "write_file":
        return tool_write_file(args.get("path", ""), args.get("content", ""), ws)
    if name == "edit_file":
        return tool_edit_file(args.get("path", ""), args.get("old_string", ""), args.get("new_string", ""), ws)
    if name == "multi_edit":
        return tool_multi_edit(args.get("path", ""), args.get("edits", []) or [], ws)
    if name == "run_command":
        return tool_run_command(args.get("command", ""), args.get("cwd", ""), ws)
    if name == "execute_code":
        return tool_execute_code(args.get("language", "python"), args.get("code", ""), args.get("cwd", ""), ws)
    if name == "list_directory":
        return tool_list_directory(args.get("path", "."), ws)
    if name == "search_files":
        return tool_search_files(args.get("pattern", ""), args.get("path", "."), ws)
    if name == "search_content":
        return tool_search_content(args.get("pattern", ""), args.get("path", "."), args.get("file_pattern", "**/*"), ws)
    if name == "web_search":
        try:
            return asyncio.get_event_loop().run_until_complete(tool_web_search(args.get("query", "")))
        except RuntimeError:
            return asyncio.run(tool_web_search(args.get("query", "")))
    if name == "web_fetch":
        try:
            return asyncio.get_event_loop().run_until_complete(tool_web_fetch(args.get("url", "")))
        except RuntimeError:
            return asyncio.run(tool_web_fetch(args.get("url", "")))
    if name == "todo_write":
        return tool_todo_write(args.get("todos", []) or [])
    # Git tools
    if name == "git_status":
        return tool_git_status(ws)
    if name == "git_log_summary":
        return tool_git_log_summary(args.get("n", 10), ws)
    if name == "git_diff_tool":
        return tool_git_diff_tool(args.get("ref", ""), ws)
    if name == "git_commit":
        return tool_git_commit(args.get("message", ""), ws)
    if name == "git_create_branch":
        return tool_git_create_branch(args.get("name", ""), ws)
    if name == "git_checkout":
        return tool_git_checkout(args.get("branch", ""), ws)
    if name == "git_push":
        return tool_git_push(args.get("set_upstream", False), ws)
    return f"Error: Unknown tool '{name}'"


async def execute_tool_async(name: str, args: dict, workspace: str) -> str:
    """Async variant that properly awaits web tools without event-loop hacks."""
    ws = workspace or ""
    if name == "web_search":
        return await tool_web_search(args.get("query", ""))
    if name == "web_fetch":
        return await tool_web_fetch(args.get("url", ""))
    return execute_tool(name, args, ws)
