# Changelog

## 1.2.0 — 2026-04-21

### Added
- **BM25 RAG** — Automatically retrieves relevant code snippets from your workspace and injects them into context before each message. Cache invalidates after file writes.
- **Custom Ollama model** — Backend now runs `silo-qwen` (Qwen3 14B with tuned sampling: temperature 0.25, top_k 40, repeat_penalty 1.12, 32k context).
- **PR Review** — `/review` slash command and dropdown button streams an AI review of your current git diff.
- **Chat Export** — `/export` saves the current conversation as a Markdown file.
- **Web Search** — `/search` and agent `web_search` tool (Auto mode only).
- **Git tools** — Agent can run `git_status`, `git_log`, `git_diff`, `git_commit`, `git_create_branch`, `git_checkout`, `git_push` autonomously.
- **Token counter** — Cloud model responses show input/output token usage.
- **Files-modified badge** — After multi-file edits, shows how many files were touched.
- **Message rail dots** — Left-side timeline with per-message indicators (Claude Code style).
- **3-dot wave loader** — Replaces the old orbital spinner.

### Changed
- **Ask mode** — No longer has access to `web_search` / `web_fetch`. Only local filesystem reads. Prevents spurious web searches on simple messages.
- **System prompt** — Added few-shot examples and clearer tool-use rules. Model now correctly ignores tools for greetings and casual messages.
- **UI** — Editorial typography (Instrument Serif + Geist + JetBrains Mono), gold glow effects, floating input box, backdrop-blur dropdowns, animated empty state.

### Fixed
- Model no longer calls `web_search` when greeted with "hola" or other conversational messages.
- `SILO.md` project memory updated to reflect Qwen3 (was showing Qwen2.5 from old planning doc).

---

## 1.1.0 — 2026-04-20

Major release. Silo now works as a full agentic coding assistant, both local and cloud.

### Added
- **Modes** — Ask, Plan, Auto. Plan restricts the agent to read-only tools; Auto enables full read/write/execute.
- **Cloud providers** — Use OpenAI, Anthropic (Claude), or Google Gemini alongside the local Ollama model. API keys are stored in VS Code SecretStorage (never on disk).
- **Add / Edit / Remove AI** — Manage cloud models directly from the model picker. Destructive actions ask for confirmation.
- **Slash commands** — `/clear`, `/compact`, `/new`, `/mode ask|plan|auto`.
- **Todo panel** — Agent tracks multi-step work with a live todo list.
- **Persistent memory** — Agent reads `SILO.md` / `CLAUDE.md` from your workspace.
- **Auto-compaction** — Long conversations get summarized to save context.
- **Diagnostics + git diff** — Current problems and unstaged changes are sent with every message.
- **Multi-chat history** — Sidebar lists prior conversations. Empty chats (no messages) are not saved.
- **Stop / regenerate** — Abort a streaming response mid-flight.
- **Image paste** — Paste screenshots into the chat for multimodal models.

### Changed
- Full UI redesign — cleaner model picker, hover icons, active indicator.
- Ollama tool-calling loop replaces the old single-shot chat.

### Security
- API keys stored in VS Code SecretStorage.
- No secrets are logged or sent anywhere except the configured provider endpoint.
- Backend binds to `127.0.0.1` only.

---

## 1.0.4

- Error handling, code blocks, stop/stream UX, model logos, input improvements.

## 1.0.3

- UI redesign, model switcher, image paste, multi-chat history.

## 1.0.2

- UI redesign, model switcher, image paste support.

## 1.0.1

- Activity bar button with sidebar chat panel.
