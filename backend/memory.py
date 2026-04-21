"""Load SILO.md / CLAUDE.md from workspace + global home."""
import os
from pathlib import Path


def _read_safe(path: str) -> str:
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                return f.read().strip()
    except Exception:
        pass
    return ""


def load_memory(workspace: str) -> str:
    """Return concatenated SILO.md / CLAUDE.md content (global + project)."""
    parts: list[str] = []

    home = str(Path.home())
    for name in ("SILO.md", "CLAUDE.md"):
        content = _read_safe(os.path.join(home, ".silo", name))
        if content:
            parts.append(f"## Global memory ({name})\n{content}")
            break

    if workspace and workspace != "__global__":
        for name in ("SILO.md", "CLAUDE.md"):
            content = _read_safe(os.path.join(workspace, name))
            if content:
                parts.append(f"## Project memory ({name})\n{content}")
                break

    return "\n\n".join(parts)
