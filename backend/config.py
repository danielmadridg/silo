import os

# Ollama backend
OLLAMA_BASE_URL = "http://127.0.0.1:11434"
MODEL_NAME = "silo-qwen"   # custom model with tuned Modelfile (fallback: qwen3:14b)

MAX_TOKENS_CHAT = 4096
MAX_TOKENS_COMPLETE = 256
PORT = 8942
HOST = "127.0.0.1"

# ── Base options ───────────────────────────────────────────────────────────────
BASE_OPTIONS: dict = {
    "num_gpu":        99,      # offload all layers to GPU
    "low_vram":       False,
    "use_mmap":       True,    # memory-mapped load — faster cold start
    "f16_kv":         True,    # fp16 KV cache — 2× savings, same quality
    "num_batch":      512,
    "num_ctx":        16384,
    "num_predict":    MAX_TOKENS_CHAT,
    # Sampling — tuned for code precision
    "temperature":    0.25,    # lower = more deterministic code
    "top_k":          40,      # sample from top 40 tokens (was default 20 — too greedy)
    "top_p":          0.92,
    "repeat_penalty": 1.12,    # penalise repeated phrases more strongly
    "repeat_last_n":  128,     # look back 128 tokens for repetition
    "tfs_z":          1.0,     # tail-free sampling (1.0 = off; tune to 0.95 if verbose)
    "typical_p":      1.0,     # locally typical sampling (1.0 = off)
}

# ── Turbo options — maximum performance ───────────────────────────────────────
_cpu_count = os.cpu_count() or 4
TURBO_OPTIONS: dict = {
    "num_thread":     _cpu_count,
    "num_ctx":        32768,
    "num_batch":      1024,
    "num_predict":    8192,
    "temperature":    0.15,    # near-deterministic for large refactors
    "top_k":          30,
    "repeat_penalty": 1.15,
}

def get_options(turbo: bool = False) -> dict:
    opts = {**BASE_OPTIONS}
    if turbo:
        opts.update(TURBO_OPTIONS)
    return opts
