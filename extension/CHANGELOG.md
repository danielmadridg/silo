# Changelog

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
