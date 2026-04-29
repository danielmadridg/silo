# Changelog

## 1.5.0 — 2026-04-29

### Added
- **Phi context awareness** — Phi-4 now gets a tailored "no tools" system prompt that explains it has full context (active file, diagnostics, git diff, retrieved snippets) but cannot call functions. No more "I don't have access to your PC" responses.
- **Live thinking stream** — Qwen 3.6 reasoning tokens appear in real time in a collapsible Reasoning panel.
- **Thinking toggle** — switch in the model picker turns Qwen's `<think>` mode on/off per request.
- **Auto-model selector** — toolbar button auto-picks Qwen (complex/code) or Phi (fast/conversational) based on the prompt. Supports Spanish keywords.
- **Slash command autocomplete** — type `/` for a floating command list with arrow-key navigation.
- **Plan mode** — Claude Code–style 6-step flow: think → explore → `ask_user` (clickable options) → numbered plan → todo checklist → "Switch to Auto" handoff button.
- **Markdown rendering** — bold, italic, inline `code`, headings, lists, blockquotes, links, fenced code blocks with Copy button.
- **Centered dropdowns** — all toolbar dropdowns open centered above the input bar — no more cut-off in narrow sidebars.

### Changed
- **Local model selection** — the active model selected in the UI now reaches the backend on every chat request (previously the agentic loop hardcoded `silo-qwen`).
- **System prompts** — modes Ask, Plan, and Auto each get a distinct prompt; Plan and Auto remain agentic, Ask uses an approval-preview flow.

### Fixed
- Phi-4 400 error — `silo-phi` (no tool calling) now correctly routes to a simple stream without sending tool schemas.
- Webview SyntaxError — `\n` inside a regex literal embedded in a template literal was producing a literal newline (invalid in Chromium V8). Replaced with `\\n` and removed unneeded `\n` from character classes.
- TypeScript casts (`as any`, `as HTMLElement`) inside the webview template literal caused runtime SyntaxErrors. Removed all of them.
- Active file pill now retains the last open file when focus moves to the chat panel — no more flicker to "no file".
- Fallback model after removing a cloud model is now `silo-qwen` (was a non-existent `qwen3:14b`).

---

## 1.3.0 - 2026-04-28

This is the next Marketplace release after `1.2.0`.

### Added
- **Ask-mode edit approvals**: Ask can prepare edits, but the UI shows a unified diff with **Apply** and **Reject** before any file is changed.
- **Checkpoints**: Silo writes patch checkpoints under `.silo/checkpoints/` before Auto/Edit changes and before approved Ask edits.
- **Explicit context mentions**: use `@file`, `@folder`, `@codebase`, and `@docs` to steer what Silo reads.
- **Context meter**: the input shows an estimated token budget while typing.
- **MCP bridge**: configured tools in `.silo/mcp.json` can be called through `mcp_call_tool`.
- **Automatic project checks**: after Auto/Edit file changes, Silo detects common compile/lint/test commands and streams their results back into the agent loop.
- **Persistent project instructions**: Silo now reads `SILO.md`, `CLAUDE.md`, `.silo/SILO.md`, `.silo/CLAUDE.md`, and `.silo/instructions.md`.
- **Slash command autocomplete**: type `/` to browse commands with keyboard navigation.
- **Live thinking stream**: Qwen reasoning tokens appear in a collapsible Reasoning block.
- **Thinking toggle**: enable or disable local thinking mode from the model picker.
- **Auto model selection**: Silo can choose Qwen for complex prompts and Phi for shorter prompts.
- **Plan mode**: read-only planning with exploration, clarification, todos, and handoff to Auto mode.
- **Phi-4 local model**: added `silo-phi` as a fast local option beside `silo-qwen`.
- **Expanded Add AI providers**: compact presets for OpenAI, Anthropic, Gemini, DeepSeek, xAI, Groq, Mistral, OpenRouter, Together AI, Fireworks, Perplexity, Cerebras, NVIDIA, Moonshot, Qwen, and custom OpenAI-compatible endpoints.

### Changed
- Version normalized to `1.3.0` because `1.2.0` is the latest published Marketplace version.
- Auto/Edit keeps full tool access and applies changes directly.
- Ask mode now uses approval previews instead of applying edits directly.
- Default local model is `silo-qwen`, with `silo-phi` used for faster local responses when selected.
- Dropdowns open centered above the input bar.
- Active-file context now stays stable when focus moves to the chat panel.
- Markdown now renders while streaming, including bold, italic, inline code, code blocks, lists, and headings.
- The status indicator uses a gold shimmer and says `Siloing...`.
- The sidebar now restores the previously open chat after webview reloads or reopening VS Code.
- Add AI now uses compact searchable dropdowns for provider and model selection.
- Open Silo chat panels are restored by VS Code after Reload Window or reopening the editor.
- Prompt language matching now follows the latest user message, preventing Phi from sticking to Spanish after an English prompt.
- Assistant file references like `src/app.ts:42` are clickable and open directly in VS Code.
- Streaming no longer forces the chat to the bottom while the user scrolls upward.
- Thinking mode is now enabled only for models that support a reasoning stream, including `silo-qwen` and user-added DeepSeek reasoning models.
- Fixed clickable file detection for simple references such as `README.md`.

### Fixed
- Fixed Markdown formatting being lost at the end of streamed messages.
- Fixed code block parsing in the webview template.
- Fixed local model selection not always reaching the backend.
- Fixed `silo-phi` routing by disabling tool-calling for models that do not support it.
- Fixed fallback model after removing a cloud model.
- Fixed webview JavaScript syntax issues caused by unsafe casts and escaping inside template literals.

---

## 1.2.0 - 2026-04-21

### Added
- **BM25 RAG**: automatically retrieves relevant workspace snippets and injects them into context.
- **Custom Ollama model**: backend runs `silo-qwen` with tuned sampling.
- **PR review**: `/review` streams an AI review of the current git diff.
- **Chat export**: `/export` saves the current conversation as Markdown.
- **Web search**: `/search` and Auto-mode web tools.
- **Git tools**: status, log, diff, commit, branch, checkout, and push.
- **Token counter** for cloud model responses.
- **Files-modified badge** after multi-file edits.
- **Message rail dots** with per-message indicators.

### Changed
- Ask mode no longer has web tools.
- System prompt has clearer tool-use rules and few-shot examples.
- UI uses editorial typography, gold accents, floating input, and animated empty state.

### Fixed
- Reduced unnecessary web searches on greetings and casual messages.
- Updated project memory to reflect the current local model.

---

## 1.1.0 - 2026-04-20

### Added
- Modes: Ask, Plan, Auto.
- Cloud providers: OpenAI, Anthropic, and Gemini.
- Add, edit, and remove cloud models from the model picker.
- Slash commands: `/clear`, `/compact`, `/new`, and `/mode`.
- Todo panel for multi-step work.
- Persistent memory from `SILO.md` / `CLAUDE.md`.
- Auto-compaction for long conversations.
- Diagnostics and git diff context.
- Multi-chat history.
- Stop generation.
- Image paste.

### Changed
- Full UI redesign.
- Ollama tool-calling loop replaced the older single-shot chat flow.

### Security
- API keys are stored in VS Code SecretStorage.
- Backend binds to `127.0.0.1`.

---

## 1.0.4

- Error handling, code blocks, stop/stream UX, model logos, input improvements.

## 1.0.3

- UI redesign, model switcher, image paste, multi-chat history.

## 1.0.2

- UI redesign, model switcher, image paste support.

## 1.0.1

- Activity bar button with sidebar chat panel.
