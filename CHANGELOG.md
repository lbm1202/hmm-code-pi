# Changelog

All notable changes to the Hmm-code Pi extension are documented here.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) + [SemVer](https://semver.org).

This extension is **not** published to npm directly; it ships bundled inside the [hmm-code VS Code extension](https://github.com/lbm1202/hmm-code-vscode) `.vsix`. Standalone install is via `git clone` (see README).

## [Unreleased]

### Added
- `/compact` slash command — manually compact the session context now (overrides Pi's built-in to add a "Compacting…/Context compacted." notify, footer refresh, and an in-flight guard). Shared by the VS Code compact button.

### Changed
- Auto-compact watchdog timeout 60s → 10 min. Compaction summarizes the whole conversation with the active model, so a large context on a reasoning model can legitimately take minutes; the old 60s backstop re-armed mid-summary and risked double-triggering a second compaction.

## [0.1.1-rc1] — 2026-05-29

Pre-release (release candidate) — ships bundled in hmm-code-vscode 0.1.1-rc1.

### Added
- `modes.json:autoCompactThreshold` — overrides the built-in `AUTO_COMPACT_THRESHOLD` for context auto-summarization. Clamped to `[40, 95]` on load; editable from the VS Code settings panel.
- `LICENSE` (MIT).
- `CHANGELOG.md`.

### Changed
- `ask_user` multi-select dialog strings are now English (`(multi-select)`, `Done`, `Selected:`). The `(multi-select)` title prefix is the contract the VS Code webview detects.
- Trimmed non-structural blank lines in `DEFAULT_MODES` system-prompt addenda (kept section separators; prompt text unchanged).
- Translated README, WORKFLOW.md, PERMISSIONS.md, AGENTS-MD.md, ANALYSIS.md to English. Updated stale references (auto-injection mechanism, finalize_plan schema, Ctrl+Shift+A keybinding, /thinking-toggle slash command).
- `STATUS_KEYS.AUTO_APPROVE` constant introduced; raw `"auto-approve"` strings replaced.
- Internal cleanup — removed dead exports, deduped `ansi24`, removed `writePermissionsExampleIfMissing` no-op shim, demoted internal-only exports to module-local.

## [0.1.0] — 2026-05-29

Captures the project state at the time of the first hmm-code VS Code release.

### Added
- Four-mode system: plan / code / debug / ask. Each mode has independent model, thinking level, active tools, system prompt.
- Slash commands: `/mode`, `/mode-set`, `/plan-execute`, `/reset`, `/reload-runtime`, `/auto-approve`, `/thinking-toggle`.
- TUI shortcuts: `Tab` / `Ctrl+Alt+M` (mode cycle), `Alt+T` (thinking toggle), `Alt+X` (reset to defaults), `Ctrl+Shift+A` (auto-approve toggle).
- Tools: `ask_user` (multi-question with multiselect), `request_mode_switch`, `finalize_plan`, `todo_write`.
- `finalize_plan` schema: `summary` + `body` + `steps` + `validation` + `docs?` + `target_mode?`.
- Three-way `finalize_plan` dialog: new session / current session (deferred dispatch) / revise.
- Auto-generated session titles (`auto-title.ts`, fire-and-forget so Pi exits "Working…" promptly).
- AGENTS.md auto-injection: `${cwd}/AGENTS.md` + `~/.pi/agent/AGENTS.md`.
- Tool-call name sanitizer for malformed names from local models (Qwen vLLM, etc.).
- Auto-compact at 75% context usage.
- Permission system (Kilo-aligned):
  - Layered evaluation — base defaults → mode defaults → global → project → `.piignore`.
  - Last-match-wins per layer, strongest-wins across layers.
  - `BASH_DEFAULT` (code/debug) — `ask` baseline + 30+ safe allows + shell-metachar `ask` (so `cat * | rm` can't bypass).
  - `BASH_READ_ONLY` (plan/ask) — `deny` baseline + read-only allows + git-introspection re-allow + shell-metachar hard deny.
  - `external_directory` layer for absolute paths outside the workspace.
  - `.piignore` parser (workspace-relative, gitignore syntax).
  - `external_directory` extraction from bash command arguments.
  - Defaults use `**` for recursive matches — earlier `*` form was single-segment only and silently let nested paths bypass.
- Auto-approve session toggle (CLI / TUI shortcut / VS Code button).
- Headless detection: `ctx.hasUI === false` denies `ask` to avoid hangs.
- `STATUS_KEYS` constants — `mode`, `model`, `thinking`, `overridden`, `context`, `plan-handoff`, `todos`, `auto-approve`.
- VS Code RPC contract: state pushes via `setStatus` mirror onto webview pickers / chips.

### Fixed
- `.piignore` ignored absolute-path tool inputs (normalized to cwd-relative now).
- `auto-title` `setSessionName` no longer throws when the session ended before the async LLM call resolved (try/catch).

[Unreleased]: https://github.com/lbm1202/hmm-code-pi/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lbm1202/hmm-code-pi/tree/main
