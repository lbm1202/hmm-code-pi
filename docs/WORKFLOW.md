# Workflow

Core invariant: **code edits happen only in `code` mode, entered via `plan → code` (`finalize_plan`)** — with one exception: a localized, already-diagnosed fix may switch `debug → code` directly (the diagnosis is its spec). `debug` / `ask` otherwise feed plan with richer input context; they're not where edits happen.

```
ask ───────────────► request_mode_switch("plan", reason, summary)
                                                                  \
debug ─────────────► request_mode_switch("plan", reason, summary) ─► plan ─► finalize_plan ─► code
      └────────────► request_mode_switch("code")  ── localized, already-diagnosed fix ─────────► code
                                                                  /                       (new-session OR current-session)
plan ───────────────────────────────────────────────────────────/
```

---

## 1. Mode switching

### User-initiated
- Slash: `/mode code`, `/mode plan`, `/mode debug`, `/mode ask`.
- Slash with no arg: `/mode` → picker (4 modes + current marker).
- TUI shortcut: `Tab` / `Ctrl+Alt+M` (`Shift+Tab` is reassigned to Pi autocomplete).
- VS Code: click the mode picker chip in the footer.

Switching invokes `state.apply(name)` immediately — model / thinking / activeTools update and the system prompt addendum recomposes the next time `before_agent_start` fires.

### LLM-proposed (`request_mode_switch`)
LLM calls `request_mode_switch(target_mode, reason, context_summary)` → user confirm dialog → auto-applied on accept.

**Triggers** (encoded in the system prompt):
- The user explicitly signaled they want a plan ("let's plan this", etc.).
- The current mode's work reached a natural endpoint (debug finished diagnosis; ask delivered the explanation).

The system prompt also says: do **not** call this mid-task just because something feels relevant.

**Constraints**:
- `target_mode === currentMode` → returns isError + "already in that mode".
- `target_mode === "code"` from a non-`debug` mode → returns isError ("code is reached via `finalize_plan`, or `debug → code` for a diagnosed localized fix"). From `debug`, a `code` switch IS allowed — the diagnosis serves as the fix's spec, so a one-line fix needn't round-trip through plan.
- Headless session (`!ctx.hasUI`) → returns isError immediately (no UI to confirm with).

---

## 2. plan → code handoff (`finalize_plan`)

The only mutating tool in plan mode. Calling it opens a 3-way dialog:

> **Finalize plan**
>
> Review the plan and choose:
>
> - **[A]** Run in a new session in code mode *(recommended)*
> - **[B]** Switch the current session to code mode
> - **[C]** Revise the plan (free-form input)
>
> Esc: defer (the plan file is already saved)

The plan file (`.pi/plans/plan-<adjective>-<noun>.md`) is always written — even the revise / cancel branches keep it.

### Schema

```ts
finalize_plan({
  summary: string,             // required. 1-2 sentences. Used in dialog/picker previews.
  body: string,                // required. Free-form markdown (### and deeper). Current state, file layout, data model, strategy, risks.
  steps: string[],             // required. Execution order — the checklist LLM follows.
  validation: string[],        // required. Validation commands / scenarios. For trivial fixes, one line: "No verification needed — ..."
  docs?: string[],             // optional. Docs to update (e.g. "README.md: Setup section").
  target_mode?: "code" | "debug",
})
```

### Output markdown

```markdown
# Plan
- Created: ... / Target mode: ... / Source model: ...

## Summary
{summary}

## Design        ← only when body is set (required, so always)
{body}           ← LLM writes ### and deeper. Using ## would clash with Summary/Steps level.

## Steps
1. ...

## Validation    ← required, so always
- ...

## Documentation ← only when docs is set (optional)
- ...
```

The VS Code inline plan preview ([`tools.ts:renderFinalizePlanPreview`](https://github.com/lbm1202/hmm-code-vscode/blob/main/webview/tools.ts)) renders the same structure so the user can scan the body before answering the dialog.

### A. New session
1. Save the plan file.
2. `ctx.newSession({ parentSession, withSession })` spawns a fresh session.
3. Inside that session, `applyMode("code")`.
4. Inject the plan body as the first user message ("Implement the following plan as-is …").
5. Linked to the parent in the session picker tree automatically.

### B. Current session
1. Save the plan file.
2. `state.apply("code", ctx)` — mode switch.
3. Stash the plan body on `state.pendingCurrentSessionPlanBody`.
4. **Return `terminate: true`** → current agent loop ends.
5. `agent_end` hook fires → reads the stash → `pi.sendUserMessage(body)` → next loop starts with the new mode's config.

**Why the stash**: Pi's `createLoopConfig` captures `{ model, thinkingLevel, activeTools, systemPrompt }` once at loop start. Calling `applyMode` inside the same loop updates the state but the captured config sticks. Terminating the loop and dispatching from `agent_end` ensures the next loop captures the fresh config.

### C. Revise
1. Save the plan file.
2. `ctx.ui.input(...)` for free-form feedback.
3. Pass the feedback back as the tool result ("user requested changes: ...").
4. Stay in plan mode → LLM rewrites and calls `finalize_plan` again.

---

## 2b. code → review handoff (`finalize_implementation`)

The mirror of `finalize_plan`, closing the plan → code → review loop. The plan-handoff body tells the code session to call `finalize_implementation` once every step is done and the validation pass is green (code targets only — debug handoffs don't get it).

### Availability (review-target gating)
The tool is injected into code mode **only when the session has a review target**: a parent plan session in the header (plan handoff), OR `finalize_plan` ran in this session (current-session execution — tracked via `state.planFinalizedInSession`, persisted as a `PLAN_FINALIZED_ENTRY` custom entry and restored on session_start). Standalone code sessions never see the tool; an in-tool guard backs the injection gate.

### Schema
`summary` (declarative outcome) + `changes` (per-file `<path>: <what>` — every created/modified/deleted file) + `validation_results` (each plan validation entry with PASS / FAIL / SKIPPED-with-reason) + optional `deviations` (intentional differences from the plan, with why) + optional `plan_path` (reviewer fallback if the plan left their context).

### Flow
1. Guard: code mode + review target.
2. Dialog (`ctx.ui.select`, mirroring finalize_plan): **1. Hand off to review / 2. Continue implementing / 3. Not now**. Headless runs skip it and auto-review in place.
   - *Continue*: `ctx.ui.input` collects what's missing; the feedback goes back to the model as the tool result. No report is written.
   - *Not now / dismissed*: defer; the model waits. No report is written.
3. On **Hand off to review** only: write the implementation report to `~/.pi/agent/reports/impl-<date>-<name>.md` (`plans.ts:uniqueReportPath`) and resolve the **parent plan session** from this session's header (`state.parentSessionPath` — recorded by the client at plan-handoff time; empty for current-session executions or a deleted parent).
4. Branch:
   - **RPC client (VS Code)** — `hasUI && !state.hasEditor()`: emit `setStatus(REVIEW_HANDOFF, "<reportPath>|<parentSessionPath or empty>")`, `terminate: true`. The client switches to the parent session (or reviews in place when empty), sends `/review-begin`, then injects the review prompt referencing the report. Parent resolution is Pi-side so the handoff survives webview reloads.
   - **TUI / headless**: review in the CURRENT session — `state.apply("review", ctx)`, stash the review prompt on `state.pendingModeSwitchMessage`, `terminate: true` (same agent_end fresh-loop dispatch as branch B above).
5. Review mode verifies files + contracts, runs the plan's Validation entries, ends with PASS or findings, and stops. **The session then auto-returns to its prior mode**: handoff entries (`/review-begin` or the same-session branches) stash the pre-review mode on `state.pendingReviewRevertMode`, and the `agent_end` hook reverts once the review reply's turn completes (a manual mode change mid-review wins; manual `/mode review` never auto-returns). A user-requested fix round calls `finalize_plan` (allowed from plan AND review) with the fix-list as steps → new code session → review again.

### Artifact retention
Plan files and implementation reports are garbage-collected at session start once older than `modes.json:artifactRetentionDays` (default **30**, `0` = keep forever; `plans.ts:cleanupArtifacts`) — mirroring Claude Code's `cleanupPeriodDays` model. Editable from the VS Code settings panel (General tab).

---

## 3. debug / ask → plan handoff

`request_mode_switch("plan", reason, context_summary)`:

```ts
state.pendingModeSwitchMessage =
    `Carry-over from ${origin} mode:\n${params.context_summary.trim()}\n\nPlease continue.`;
```

Same stash + agent_end dispatch as `finalize_plan` branch B — for the same reason. Without it, the carry-over message would be sent with the PRE-switch model and tools.

`agent_end` hook:
```ts
const body = state.pendingCurrentSessionPlanBody ?? state.pendingModeSwitchMessage;
if (!body) return;
state.pendingCurrentSessionPlanBody = undefined;
state.pendingModeSwitchMessage = undefined;
setImmediate(() => pi.sendUserMessage(body));
```

---

## 4. Per-mode tools and system prompts

| Mode | activeTools (LLM-visible) | systemPromptAddendum gist |
|---|---|---|
| **plan** | read, grep, find, ls, bash, **ask_user, request_mode_switch, finalize_plan** | 3 phases: investigate → design + ask → finalize_plan. No write/edit + interpreter-bypass guard. Use ask_user for branching decisions, finalize_plan to commit. |
| **code** | read, edit, write, bash, grep, find, ls, **ask_user, request_mode_switch, todo_write, finalize_implementation** | Implement as planned. ask_user only for real forks. Use todo_write proactively (3+ steps, user-listed items, plan handoff). finalize_implementation after the acceptance pass when implementing a finalized plan. |
| **debug** | read, bash, grep, find, ls, **ask_user, request_mode_switch, todo_write** | Hypothesize → reproduce → analyze logs. No edit/write + interpreter-bypass guard. Don't propose a mode switch mid-investigation. |
| **ask** | read, grep, **ask_user, request_mode_switch** | Explanation-focused. Minimize tool calls. Only propose a plan switch when the user signals intent. |
| **review** | read, bash, grep, find, ls, **ask_user, request_mode_switch, finalize_plan** | Verify an implementation against its plan: read report + changed files, check pinned contracts, run every Validation entry, report PASS/findings and STOP. Full bash for verification; no file mutation. finalize_plan for a user-requested fix round. |

`edit` / `write` are auto-stripped from plan/debug/ask/review `activeTools` (`mode-tools.ts:PROTECTED_FROM_NON_CODE`). Adding them in `modes.json` is silently ignored with a warning.

---

## 5. Loop-capture issue when modes change in-session

### Problem
Pi's agent loop (`runPromptMessages`) captures at startup:
- Active model + thinking level
- Active tool list
- System prompt

Calling `applyMode` inside the same loop updates the state but the loop keeps using its captured config. Follow-up messages get the old setup.

### Fix
Every mode-switch branch returns `terminate: true`. The loop ends. The next loop (next user message or deferred dispatch) captures the fresh config.

Tools that do this:
- `finalize_plan` (branch B)
- `request_mode_switch` (on accept)

Stash → `agent_end` → dispatch is the pattern.

---

## 6. Session lifecycle events

| Event | When | What our handler does |
|---|---|---|
| `session_start` | Session start (cold start / reload / new / resume / fork) | `loadModes`, AGENTS.md re-eval, mode restore (`restoreFromSession`), keybindings/settings auto-install, **auto-approve reset to OFF** |
| `before_agent_start` | Each user prompt cycle (= `runPromptMessages` invocation) | Compose system prompt: base + mode addendum + AGENTS.md (global → project) |
| `agent_start` | (Just after the above) | (Pi-internal) |
| `before_provider_request` | Right before each LLM API call | Inject the mode's temperature / chatTemplate, Qwen `enable_thinking` helper |
| `tool_call` | Right before every LLM tool call | **Permission evaluation** (.piignore → layered rules → ask/allow/deny). Auto-approve bypasses `ask` here. |
| `tool_execution_start/update/end` | Tool execution phases | (Pi-internal) |
| `message_end` | One LLM message complete | Auto-title generation (first user→assistant pair, once per session) |
| `agent_end` | User prompt cycle ends | **Deferred dispatch** — if `pendingCurrentSessionPlanBody` / `pendingModeSwitchMessage` is set, fire `pi.sendUserMessage` |

---

## 7. Session manager / picker

Session files: `~/.pi/<workspace-hash>/sessions/<timestamp>_<rand>.jsonl`

- New session: `/new-session` or the VS Code ⊕ button.
- Session picker: parent-child tree (sessions spawned by `finalize_plan` new-session branch link to their parent).
- Rename: stored in the sidecar `.pi-modes-names.json` (Pi's session files stay immutable).
- Delete: single + cascade. **Deleting the active session auto-spawns a fresh one** (handled by VS Code's `ChatBackend` `DELETE_SESSION` handler).

---

## 8. Model / thinking / override

`/mode` switching applies the mode's default model + thinking. Picking different values in the picker enters "overridden" state → the footer shows the `Alt+X → default` cell.

`Alt+X` (or `/reset`) restores the mode default.

The auto-title model is separate. After the first user→assistant pair completes, a small GPT-mini model generates the session title. Configurable via `modes.json:autoTitle.{provider,id}`.

---

## 9. Permission system

Full reference: [PERMISSIONS.md](./PERMISSIONS.md).

In short:
- Layer 1 = `activeTools` (which tool types the mode exposes).
- Layer 2 = path/bash rules (BASE_DEFAULTS + MODE_DEFAULTS + user global/project + .piignore).
- Auto-approve toggle bypasses `ask` for the duration of a session.

---

## 10. AGENTS.md

Full reference: [AGENTS-MD.md](./AGENTS-MD.md).

In short: when `${cwd}/AGENTS.md` and/or `~/.pi/agent/AGENTS.md` exist, they're appended to the system prompt on every user prompt cycle.
