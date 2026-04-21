"""
Simple keyword-based RAG (Retrieval-Augmented Generation).

No ML libraries needed — uses TF-IDF-like scoring over workspace code files.
Indexes on first call per workspace, caches for 60s.
"""
import os
import re
import math
import time
from pathlib import Path

# ── Config ────────────────────────────────────────────────────────────────────
CHUNK_LINES   = 40       # lines per chunk
CHUNK_OVERLAP = 8        # overlap between chunks
MAX_FILES     = 200      # max files to index
MAX_FILE_SIZE = 150_000  # bytes — skip large files
TOP_K         = 4        # top chunks to return
MIN_SCORE     = 0.05     # minimum relevance score to include

SKIP_DIRS = {
    "node_modules", ".git", "__pycache__", ".venv", "venv", "env",
    "dist", "build", ".next", ".nuxt", "out", "target", "bin", "obj",
    ".idea", ".vscode", "coverage", ".pytest_cache", ".mypy_cache",
}
CODE_EXTENSIONS = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".cs",
    ".cpp", ".c", ".h", ".hpp", ".rb", ".php", ".swift", ".kt", ".scala",
    ".vue", ".svelte", ".html", ".css", ".scss", ".json", ".yaml", ".yml",
    ".toml", ".md", ".sql", ".sh", ".bash", ".zsh", ".fish",
}

# ── Cache ─────────────────────────────────────────────────────────────────────
_cache: dict[str, tuple[float, list[dict]]] = {}  # workspace → (timestamp, chunks)
CACHE_TTL = 60.0  # seconds


# ── Tokeniser ─────────────────────────────────────────────────────────────────
def _tokenise(text: str) -> list[str]:
    """Lowercase alphanumeric tokens, split on non-word chars."""
    return re.findall(r"[a-z0-9_]+", text.lower())


def _token_freq(tokens: list[str]) -> dict[str, int]:
    freq: dict[str, int] = {}
    for t in tokens:
        freq[t] = freq.get(t, 0) + 1
    return freq


# ── Indexer ───────────────────────────────────────────────────────────────────
def _iter_files(workspace: str):
    root = Path(workspace)
    count = 0
    for path in root.rglob("*"):
        if count >= MAX_FILES:
            break
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.suffix.lower() not in CODE_EXTENSIONS:
            continue
        if path.stat().st_size > MAX_FILE_SIZE:
            continue
        yield path
        count += 1


def _chunk_file(path: Path, workspace: str) -> list[dict]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return []

    lines = text.splitlines()
    rel = str(path.relative_to(workspace)).replace("\\", "/")
    chunks = []

    i = 0
    while i < len(lines):
        chunk_lines = lines[i : i + CHUNK_LINES]
        chunk_text = "\n".join(chunk_lines)
        tokens = _tokenise(chunk_text)
        if tokens:
            chunks.append({
                "file":   rel,
                "start":  i + 1,
                "end":    i + len(chunk_lines),
                "text":   chunk_text,
                "freq":   _token_freq(tokens),
                "total":  len(tokens),
            })
        i += CHUNK_LINES - CHUNK_OVERLAP

    return chunks


def _build_index(workspace: str) -> list[dict]:
    chunks = []
    for path in _iter_files(workspace):
        chunks.extend(_chunk_file(path, workspace))
    return chunks


def _get_index(workspace: str) -> list[dict]:
    now = time.time()
    if workspace in _cache:
        ts, chunks = _cache[workspace]
        if now - ts < CACHE_TTL:
            return chunks
    chunks = _build_index(workspace)
    _cache[workspace] = (now, chunks)
    return chunks


# ── Scorer ────────────────────────────────────────────────────────────────────
def _score(query_freq: dict[str, int], chunk: dict, idf: dict[str, float]) -> float:
    """BM25-lite score."""
    k1, b = 1.5, 0.75
    avg_len = 200  # approximate average chunk token count
    dl = chunk["total"]
    score = 0.0
    for term, qf in query_freq.items():
        if term not in idf:
            continue
        tf = chunk["freq"].get(term, 0)
        if tf == 0:
            continue
        norm_tf = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avg_len))
        score += idf[term] * norm_tf
    return score


def _build_idf(chunks: list[dict], query_terms: set[str]) -> dict[str, float]:
    N = len(chunks) or 1
    idf = {}
    for term in query_terms:
        df = sum(1 for c in chunks if term in c["freq"])
        idf[term] = math.log((N - df + 0.5) / (df + 0.5) + 1)
    return idf


# ── Public API ────────────────────────────────────────────────────────────────
def retrieve(query: str, workspace: str, top_k: int = TOP_K) -> str:
    """
    Returns a formatted string of the most relevant code snippets for the query.
    Returns empty string if workspace is empty/invalid or query is too short.
    """
    if not workspace or workspace == "__global__" or len(query.strip()) < 8:
        return ""
    if not os.path.isdir(workspace):
        return ""

    chunks = _get_index(workspace)
    if not chunks:
        return ""

    query_tokens = _tokenise(query)
    if not query_tokens:
        return ""

    query_freq = _token_freq(query_tokens)
    idf = _build_idf(chunks, set(query_freq.keys()))

    scored = [(c, _score(query_freq, c, idf)) for c in chunks]
    scored.sort(key=lambda x: x[1], reverse=True)

    top = [(c, s) for c, s in scored[:top_k] if s >= MIN_SCORE]
    if not top:
        return ""

    parts = []
    for chunk, score in top:
        parts.append(
            f"// {chunk['file']} (lines {chunk['start']}–{chunk['end']}, relevance {score:.2f})\n"
            f"{chunk['text']}"
        )

    return "\n\n---\n\n".join(parts)


def invalidate(workspace: str):
    """Force re-index on next call (call after file writes)."""
    _cache.pop(workspace, None)
