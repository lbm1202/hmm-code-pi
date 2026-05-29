# Hmm-code Pi Extension — Architecture Analysis

File-by-file architecture overview describing the current shape of the codebase and the design decisions behind it.

> Historical note: an earlier iteration had a single ~1000-line `index.ts`. It's now ~40 lines and the responsibilities are split into the per-concern modules described below.

---

## 1. Layout

| File | Purpose |
|---|---|
| `index.ts` | Bootstrap — builds the Runtime, registers tools / commands / shortcuts / hooks |
| `config.ts` | Mode schema + `loadModes()` + `DEFAULT_MODES` (system prompts) |
| `constants.ts` | `STATUS_KEYS`, `AUTO_COMPACT_THRESHOLD`, version/author single source |
| `runtime.ts` | Shared Runtime context (editor ref + footer invalidator) |
| `ui.ts` | ANSI / banner helpers, mixed-case "Hmm" glyph table |
| `plans.ts` | `~/.pi/agent/plans/` path helpers + unique name generation |
| `config-io.ts` | `modes.json` / `keybindings.json` / `settings.json` I/O |
| `state.ts` | `ModeState` (apply / reset / footer rendering); `pushStatus` for RPC clients |
| `commands.ts` | `/mode`, `/mode-set`, `/plan-execute`, `/reset`, `/reload-runtime`, `/auto-approve`, `/thinking-toggle` |
| `shortcuts.ts` | `Tab`, `Ctrl+Alt+M`, `Alt+T`, `Alt+X`, `Ctrl+Shift+A` |
| `hooks.ts` | `session_start` (header/footer/editor setup), `before_agent_start` (AGENTS.md inject), `before_provider_request`, `agent_end` (deferred dispatch), token + state invalidation, auto-compact at threshold |
| `ask-user.ts` | `ask_user` tool (multi-question card with multiselect) |
| `request-mode-switch.ts` | `request_mode_switch` tool (carry-over via deferred dispatch) |
| `finalize-plan.ts` | `finalize_plan` tool — plan file save + 3-way dialog |
| `todo.ts` | `todo_write` tool (OpenCode/Kilo schema) |
| `auto-title.ts` | First-message-pair → GPT-mini → session title (fire-and-forget) |
| `permissions/` | Permission system — see [PERMISSIONS.md](./PERMISSIONS.md) |

### `permissions/` submodules
| File | Purpose |
|---|---|
| `index.ts` | `tool_call` hook entry point — `.piignore` + layered evaluation + auto-approve bypass |
| `defaults.ts` | `BASE_DEFAULTS` + `MODE_DEFAULTS` |
| `bash-rules.ts` | `BASH_DEFAULT` + `BASH_READ_ONLY` (Kilo MIT-licensed patterns) |
| `evaluator.ts` | Layer merge + strongest-verdict + per-bash absolute-path extraction for `external_directory` |
| `glob.ts` | Lightweight minimatch (path mode + shell mode) |
| `piignore.ts` | `.piignore` parser (gitignore-style) |
| `extract-paths.ts` | Per-tool path extraction |
| `loader.ts` | JSON disk loader with mtime cache |
| `types.ts` | `Verdict` / `Permissions` / `Ruleset` schemas |

---

## 2. Data flow

### Boot sequence (`index.ts`)
1. `new ModeState(pi)` — state container.
2. `createRuntime(pi, state)` — wraps shared context (editor / footer invalidator).
3. Register the LLM-visible tools: `ask_user`, `request_mode_switch`, `finalize_plan`, `auto-title` (listener), `todo_write`.
4. Register slash commands (`commands.ts`), shortcuts (`shortcuts.ts`), and event hooks (`hooks.ts`).
5. Register the permission system (`permissions/index.ts`).

### Mutable state map
| State | Who mutates | When |
|---|---|---|
| `state.current` | `state.apply()` | Mode switch |
| `state.currentModelId/Provider` | `state.apply()`, `model_select` hook | Model change |
| `state.pendingCurrentSessionPlanBody` | `finalize_plan` (branch B) | Plan finalized → deferred dispatch |
| `state.pendingModeSwitchMessage` | `request_mode_switch` | Mode switch accepted → deferred dispatch |
| `state.autoApprove` | `/auto-approve`, `Ctrl+Shift+A`, VS Code button | User toggle |
| `state.compactInFlight` | `turn_end` auto-compact hook | While compacting |
| Filesystem (modes.json, keybindings.json, settings.json) | `updateModeConfigField`, `ensureKeybindingsOverride`, `ensureQuietStartup` | `session_start`, `/mode-set` |

### `STATUS_KEYS` (RPC ↔ UI contract)
| Key | Emitter | Reader |
|---|---|---|
| `mode` | `state.pushStatus()` | VS Code mode chip |
| `model` | `state.pushStatus()` | VS Code model chip |
| `thinking` | `state.pushStatus()` | VS Code thinking chip |
| `overridden` | `state.pushStatus()` | VS Code reset button visibility |
| `context` | `turn_end` hook | VS Code ctx pill |
| `plan-handoff` | `finalize_plan` (RPC client signal) | VS Code `runPlanHandoff` |
| `auto-approve` | `commands.ts` / `hooks.ts` | VS Code Auto button state |
| `todos` | `todo_write` | (reserved — no VS Code reader yet; future) |

---

## 3. Core invariants

1. **`edit` / `write` are code-only.** Auto-stripped from plan / debug / ask `activeTools` via `state.ts:PROTECTED_FROM_NON_CODE`.
2. **`finalize_plan` is plan-only.** The sole explicit entry to code mode.
3. **`request_mode_switch("code")` is blocked.** Code mode is reached only via `finalize_plan`.
4. **External paths still hit the permission layer.** `~/.ssh`, `/etc`, etc. go through `external_directory` rules.
5. **Loop-capture safety.** Mode switches mid-loop use stash + `agent_end` dispatch so the next loop captures the fresh model/thinking/tools (see [WORKFLOW.md §5](./WORKFLOW.md#5-loop-capture-issue-when-modes-change-in-session)).

---

## 4. Hook landscape

| Pi event | Our handler does |
|---|---|
| `session_start` | Reload modes, reset auto-approve, install keybindings/settings, restore mode, setup header/footer |
| `before_agent_start` | Compose system prompt: base + mode addendum + AGENTS.md (global → project) |
| `before_provider_request` | Inject mode's `temperature` / `chatTemplate`; Qwen `enable_thinking` helper |
| `tool_call` | Permission evaluation (.piignore → layered rules → `allow` / `ask` / `deny`); auto-approve bypasses `ask` |
| `model_select` / `thinking_level_select` | Mirror onto `state.currentModelId/Provider`; invalidate footer |
| `message_end` | Auto-title on first user→assistant pair (once per session, fire-and-forget) |
| `turn_end` | Token / context state push; auto-compact at threshold |
| `agent_end` | **Deferred dispatch** for pending plan body or mode-switch carry-over |

---

## 5. Plan handoff state machine

The deferred-dispatch pattern (`finalize_plan` branch B, `request_mode_switch` on accept):

```
Tool execute:
  apply new mode
  stash body on state.pendingX
  return { terminate: true }
        ↓
agent_end hook fires:
  read state.pendingX
  clear state.pendingX
  setImmediate(() => pi.sendUserMessage(body))
        ↓
Next user-prompt loop:
  createLoopConfig captures fresh model/thinking/tools
  body is processed with the NEW config
```

Without the terminate + deferred dispatch, the body would go through the loop's captured PRE-switch config.

---

## 6. Auto-title flow

1. `message_end` event for the assistant role.
2. First time only per session — `titledSessions` set guards.
3. Resolve a small LLM (`gpt-4.1-nano` / `gpt-4o-mini` / `gpt-4.1-mini` / code mode model / active model — first authenticated wins).
4. Mark `titledSessions` *before* the async work to prevent re-entry on stacked events.
5. **Fire-and-forget**: `void runTitleGen({...})` — `message_end` resolves immediately so Pi exits "Working…" promptly.
6. `runTitleGen` does the actual LLM call + `pi.setSessionName(title)`. Wrapped in try/catch — if the session became stale (e.g. `--print` mode finished), the failure is silent.

---

## 7. Permission system summary

Full spec: [PERMISSIONS.md](./PERMISSIONS.md).

- **Layer 1**: `activeTools` (per-mode tool visibility). The LLM only sees what's listed.
- **Layer 2**: path/bash rules.
- **`.piignore`**: gitignore-style hard deny, overrides everything.
- **Auto-approve**: session toggle that bypasses `ask` verdicts.

Layers walk `BASE_DEFAULTS → MODE_DEFAULTS → global → project`. Within a layer: last-match wins. Across layers: strongest (`deny > ask > allow`) wins.

---

## 8. AGENTS.md injection

Full spec: [AGENTS-MD.md](./AGENTS-MD.md).

On every `before_agent_start`:
- `${cwd}/AGENTS.md` + `~/.pi/agent/AGENTS.md` are concatenated onto the system prompt.
- Re-read from disk every cycle (fs cache handles the cost).
- Edits take effect on the next user prompt.

---

## 9. Tool-call name sanitizer

`hooks.ts` patches a class of failures specific to small local models (Qwen on vLLM, etc.) that occasionally emit malformed tool names. Without the sanitizer, the codex agent hard-stalls. With it, the name is repaired or the call is dropped and a synthetic assistant message instructs the LLM to retry.

---

## 10. Known limitations

- No automated test suite. Rely on `pi --print` smoke tests + manual verification when releasing.
- Nested `AGENTS.md` (per-subdirectory) not supported; the workspace root file is the only one read.
- `permissions/loader.ts` doesn't cache parse failures — every `tool_call` re-attempts to read a broken JSON. Cheap (mtime check), but worth noting.
- `auto-title` titledSessions is an in-memory Set that grows for the lifetime of the Pi process. In practice the process exits before this matters.
