# Ollama backend (replaces llama-cpp-python — no compilation needed)
OLLAMA_BASE_URL = "http://127.0.0.1:11434"
MODEL_NAME = "qwen2.5-coder:32b"    # pull with: ollama pull qwen2.5-coder:32b
# While 32B downloads, test with: MODEL_NAME = "qwen2.5:14b"

MAX_TOKENS_CHAT = 2048
MAX_TOKENS_COMPLETE = 256
PORT = 8942
HOST = "127.0.0.1"
