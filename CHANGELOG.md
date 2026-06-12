# Changelog

All notable changes to the Hmm-code Pi extension are documented here.
Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) + [SemVer](https://semver.org).

This extension is **not** published to npm directly; it ships bundled inside the [hmm-code VS Code extension](https://github.com/lbm1202/hmm-code-vscode) `.vsix`. Standalone install is via `git clone` (see README).

## [Unreleased]

## [0.1.7] — 2026-06-12

Ships bundled in hmm-code-vscode 0.1.7.

### Changed
- The agent's system prompt now includes the active session id (constant for the session's lifetime).

## [0.1.6] — 2026-06-08

Ships bundled in hmm-code-vscode 0.1.6.

### Added
- **Auto-continue after auto-compaction.** When a turn-boundary auto-compaction finishes and the todo list still has incomplete tasks, the agent is automatically prompted to continue the remaining work — so long multi-step runs don't stall on the user right after a compaction. The live todo list is tracked in session state as the "work remaining" signal; a stuck-guard pauses auto-continue after a few rounds with no task completed, and manual `/compact` never auto-continues. Gated by `modes.json:autoContinueAfterCompact` (default on), surfaced as a toggle in the VS Code settings panel.

### Changed
- **Tool-output pruning is now sticky (was a sliding window).** The `context`-hook prune kept the most-recent ~40k tokens of tool output by re-picking the kept set on every request, which shifted the cleared boundary each tool turn and invalidated the prompt cache from that point to the end — a cache miss on essentially every tool turn once the window filled. It now holds a stable boundary that only advances forward in batches: the oldest tool output is cleared only once the verbatim tail exceeds a high-water mark, then pruned back to a keep-floor, so the cached prefix stays stable between advances (roughly one cache break per batch instead of one per tool turn). The keep-floor (PROTECT) and batch/hysteresis band (MINIMUM) are derived per request from the model's context window + the auto-compact threshold, so they auto-fit any model; the newest few tool results are always kept verbatim, and the boundary resets on session_start and after compaction. Still gated by `includeOldToolOutputs` (default off → prune).

### Fixed
- **Startup banner showed a stale version.** `EXT_VERSION` was a hand-maintained literal (`v0.1.0`) that had drifted from `package.json` across several releases; the TUI banner now sources the version from `package.json` at load time (fail-soft), so it always matches the published release.

## [0.1.5] — 2026-06-05

Ships bundled in hmm-code-vscode 0.1.5.

### Fixed
- **`edit` tool calls with a misplaced `path` are auto-corrected.** Local models sometimes nest `path` inside an `edits[]` entry instead of putting it at the top level, which fails schema validation twice (missing top-level `path` + the edit object has a disallowed property) and wastes a retry round-trip. The `message_end` sanitizer now hoists a nested `edits[*].path` to the top level (and strips it from the edit) so the call validates on the first try.
- **Context % now updates on a model / mode switch.** The `context` status was only re-pushed after an assistant response, so switching to a model with a different context window left the footer % stale until the next turn. `pushStatus` (called on mode apply + model swap) now also re-pushes the context %, so it reflects the new model's window immediately. (The token count is still anchored to the last assistant usage — exact again after the next response.)

## [0.1.3] — 2026-06-04

Ships bundled in hmm-code-vscode 0.1.3.

### Changed
- **finalize_plan field guidance consolidated into the tool schema.** The per-field "how to fill it" instructions (summary/body/steps/validation/docs) now live solely in the `finalize_plan` parameter descriptions — the single source of truth, read at call-assembly time. The plan-mode system prompt no longer restates them; it keeps only the workflow (phases, when to finalize, turn-ending rule, read-only constraints) plus the two reminders that steer Phase 1 investigation rather than call formatting (pin seam contracts; every validation entry must be a headless acceptance check). Removes the prompt↔schema duplication that had already drifted — the schema's `steps`/`validation` descriptions are enriched to match the prompt's previously-richer wording.

## [0.1.2] — 2026-06-04

Ships bundled in hmm-code-vscode 0.1.2.

### Added
- **Tool-output pruning.** A `context` hook (Pi's uniform-message transform, run before provider serialization → provider-agnostic) keeps the most-recent ~40k tokens of tool output verbatim and replaces older tool-result content with a short notice before each provider request. The messages are cloned, so the on-disk transcript is never touched. Gated by `modes.json:includeOldToolOutputs` (default off → prune), surfaced as a toggle in the VS Code settings panel. Keeps the live context lean so full compaction fires far less often.

### Fixed
- **Compaction cancellation.** A duplicate `session_before_compact` registration (runtime hooks were wired per `session_start`) made one compaction fire two handlers; with a compaction-model override the second saw `ours=false` and cancelled it ("Compaction cancelled"). Hooks are now wired once (a `runtimeHooksWired` guard + a per-signal dedup defense-in-depth).
- **finalize_plan current-session handoff.** The headless plan body is deferred to a fresh agent loop (stashed on state, dispatched from `agent_end`) instead of `sendUserMessage` mid-loop — matching the mode-switch deferral pattern, so the new prompt runs with the correct captured config.

### Changed
- **`code` mode prompt** refined toward incremental delivery: implement one unit → verify it → next (rather than write-everything-then-validate), with a final acceptance pass.

## [0.1.1] — 2026-06-02

First stable on the 0.1.1 line (supersedes 0.1.1-rc1 / rc2). Ships bundled in hmm-code-vscode 0.1.1.

### Changed
- Compaction retuned: auto-compact threshold default 75 → **70**; dynamic-compaction grace band **15% → 10%**; the threshold upper bound is now mode-dependent — **80% with dynamic compaction on** (so threshold + gap stays ≤ 90), **90% with it off** (compaction happens at the threshold, no grace band). Compacting near 100% never made sense.
- **`debug → code` direct path** (loosens the plan→code invariant for one case). `request_mode_switch("code")` was hard-blocked from every mode — a localized fix discovered in debug had to round-trip through plan + finalize_plan. It's now allowed **from `debug`** (still blocked from `plan`/`ask`): when diagnosis pins a localized, already-specified fix, debug switches straight to code carrying the diagnosis as the spec. Fixes needing redesign / seam decisions still go to plan. The debug prompt also now knows it may receive a *list* of blockers (from code's end-of-build batch) and triages them. Docs (README, WORKFLOW) updated.
- Mode prompt refinements for a clearer plan → code handoff. **plan**: `finalize_plan` summary must state WHAT gets built (a declarative deliverable, not a reply to the user), and the body must pin the contracts *at the seams* — data shapes shared across components, API/file formats where two pieces must agree, cross-cutting decisions — while leaving internal function signatures to the implementer. **code**: build incrementally (implement one unit → verify it → next, rather than write-everything-then-validate) and run code / install deps through the project's own isolated environment (venv·uv / local node_modules / Cargo·Bundler / …) rather than the global system.

### Added
- **Default bash timeout (2 min).** The bash tool has no built-in timeout, so a command the model runs without one — an interactive TUI app, a dev server, a `tail -f` — never returns and hangs the turn forever (the agent waits on a tool result that never comes). The `message_end` hook now injects `timeout: 120` into any `bash` tool call that omits it; an explicit timeout (including a longer one for slow commands) is left untouched. The bash tool kills the whole process tree on timeout, so the stuck command — and its children — are cleaned up.

### Fixed
- **Permissions hardening (fail-closed):** an unrecognized or renamed file tool no longer fails open. `extract-paths` now pulls paths from the standard `path`/`file_path`/`edits` arg shape for ANY tool name, so the `external_directory` gate still runs — previously an unknown tool returned zero paths, which the evaluator treats as `allow`.
- `loadModes` validates the shape of `autoTitle`/`compactModel` (must be `{provider,id}`) and `modelAliases`/`modelAllowlist` (must be objects), degrading malformed `modes.json` values to defaults instead of propagating them downstream.

### Changed
- `/plan-execute` now runs only the plan that `finalize_plan` stashed for handoff (`state.pendingPlanPath`); the "newest `plan-*.md` by mtime" fallback (`findLatestPlan`, which scanned the global `~/.pi/agent/plans/` across all projects) is gone. The fallback only ever fed the manual-typed `/plan-execute`, where it could launch an unrelated plan from another workspace; the finalize_plan handoff always passes an explicit path and is unaffected. With nothing staged, `/plan-execute` now reports "No plan staged for handoff" instead of guessing.
- Internal: extracted the compaction policy + watchdog state machine out of `hooks.ts` into `compaction.ts` (hooks.ts 525 → 389 lines). Added a `node --test` permission test suite (`extract-paths` / `glob` / `bash-rules`); run with `npm test`.
- Internal: split `ModeState` (state.ts 413 → 319 lines) — the TUI footer box rendering moved to `mode-box.ts` and the active-tool resolution to `mode-tools.ts`, where the "edit/write are code-only" invariant is now unit-tested.

## [0.1.1-rc2] — 2026-05-30

Pre-release (release candidate) — ships bundled in hmm-code-vscode 0.1.1-rc2. Stable remains 0.1.0.

### Added
- `modes.json:autoTitlePrompt` — optional full override of the auto-title system prompt (non-empty replaces the built-in language-aware default).
- `modes.json:compactInstructions` — optional extra focus appended to the compaction prompt as "Additional focus: …" (passed as `customInstructions`; Pi's base summary prompt is unchanged). Both editable from the VS Code settings panel's new Prompts tab.
- **Dynamic compaction** (`modes.json:dynamicCompaction`, default on). The agent's multi-step turn (work → tool → work → tool) is no longer cut mid-loop to compact: compaction runs at the turn boundary (`agent_end`) once usage passes the threshold, and only force-compacts mid-loop if usage climbs `DYNAMIC_COMPACT_GAP` (15%) past the threshold. Turning it off restores the legacy behavior (compact the moment the threshold is crossed, even mid-loop). Editable from the VS Code settings panel.
- `/compact` slash command — manually compact the session context now (overrides Pi's built-in to add a "Compacting…/Context compacted." notify, footer refresh, and an in-flight guard). Shared by the VS Code compact button.
- `modes.json:compactModel` — optional dedicated model for context compaction. When set, `session_before_compact` generates the summary with that model (via the exported `compact()`) instead of the active session model; falls back to the active model on any error. Editable from the VS Code settings panel.

### Changed
- Auto-compact watchdog timeout 60s → 10 min. Compaction summarizes the whole conversation with the active model, so a large context on a reasoning model can legitimately take minutes; the old 60s backstop re-armed mid-summary and risked double-triggering a second compaction.
- Auto-title no longer fires on a turn that's also compacting (compaction in flight, or context ≥ the auto-compact threshold) — it was sending a second request to the (often local) session model alongside the compaction summary.
- Auto-title language follows the VS Code `hmm-code.language` setting (passed in as `HMM_CODE_LANG`); the standalone TUI still matches the conversation language.
- `modes.json:autoCompactThreshold` clamp tightened from `[40, 95]` to `[50, 85]` so the dynamic-compaction grace band (threshold + 15%) stays under 100.
- Internal: deduped the `mode-state` session-entry type into `constants.ts:MODE_STATE_ENTRY` and extracted the repeated ask-user option-label parsing into a `stripOptionLabel()` helper.

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

[Unreleased]: https://github.com/lbm1202/hmm-code-pi/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/lbm1202/hmm-code-pi/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/lbm1202/hmm-code-pi/tree/main
