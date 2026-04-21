import os

# Ollama backend
OLLAMA_BASE_URL = "http://127.0.0.1:11434"
MODEL_NAME = "qwen3:14b"

MAX_TOKENS_CHAT = 4096
MAX_TOKENS_COMPLETE = 256
PORT = 8942
HOST = "127.0.0.1"

# ── Performance options (applied to every Ollama request) ──────────────────
# These extract maximum performance from any hardware.
BASE_OPTIONS: dict = {
    "num_gpu":   99,      # offload ALL layers to GPU (99 = all)
    "low_vram":  False,   # don't throttle VRAM usage
    "use_mmap":  True,    # memory-mapped model files → faster cold load
    # use_mlock omitted — requires elevated privileges on Windows; Ollama handles it internally
    "f16_kv":    True,    # float16 KV cache → 2× memory savings, same quality
    "num_batch": 512,     # prompt-eval batch size → higher = faster prefill
    "num_ctx":   16384,   # context window — must fit system prompt + history + user msg
    "num_predict": MAX_TOKENS_CHAT,
    "temperature": 0.2,
    "top_p": 0.95,
    "repeat_penalty": 1.1,
}

# ── Turbo options (added on top of BASE_OPTIONS when turbo=True) ───────────
# Burns everything: all CPU threads, larger context, max batch size.
_cpu_count = os.cpu_count() or 4
TURBO_OPTIONS: dict = {
    "num_thread": _cpu_count,   # every logical CPU core
    "num_ctx":    32768,         # max context window (uses more VRAM)
    "num_batch":  1024,          # double the prefill batch
    "num_predict": 8192,         # allow much longer outputs
    "temperature": 0.15,         # slightly tighter for precision
}

def get_options(turbo: bool = False) -> dict:
    opts = {**BASE_OPTIONS}
    if turbo:
        opts.update(TURBO_OPTIONS)
    return opts
