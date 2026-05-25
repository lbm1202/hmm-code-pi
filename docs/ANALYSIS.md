# Pi Modes Extension — Refactor Analysis

분석 시점: 2026-05-25  
분석 대상 커밋: `7682ecd` (auto-title, todo_write, refined mode prompts)

---

## 1. 현재 구조 요약

| 파일 | 라인 | 역할 |
|---|---|---|
| [index.ts](index.ts) | 1003 | 부트스트랩 + 커맨드/단축키/이벤트 핸들러 + 헤더/푸터 UI + 설정 파일 I/O — **모든 게 한 파일에 있음** |
| [state.ts](state.ts) | 304 | `ModeState` 클래스: 현재 모드/모델/thinking, 도구 필터, 푸터 박스 렌더 |
| [config.ts](config.ts) | 121 | 모드 스키마 + 기본값 + `loadModes()` |
| [finalize-plan.ts](finalize-plan.ts) | 272 | `finalize_plan` 툴 (계획 저장 + 새 세션/현재 세션/수정 분기) |
| [auto-title.ts](auto-title.ts) | 191 | 첫 메시지 후 GPT-mini 로 세션 제목 자동 생성 |
| [todo.ts](todo.ts) | 132 | `todo_write` 툴 (OpenCode/Kilo 스펙) |
| [ask-user.ts](ask-user.ts) | 117 | `ask_user` 툴 (멀티 질문 + Other 입력) |
| [request-mode-switch.ts](request-mode-switch.ts) | 88 | `request_mode_switch` 툴 |

**총 ~2228 lines.** index.ts 가 전체의 45%.

---

## 2. 아키텍처 데이터 흐름

### 부트 순서 (index.ts `modesExtension(pi)`)
1. `new ModeState(pi)` — 상태 컨테이너 생성
2. 7개 툴 등록: `ask_user`, `request_mode_switch`, `finalize_plan`, `todo_write` + auto-title 리스너
3. 4개 커맨드: `/mode`, `/mode-set`, `/plan-execute`, `/reset`
4. 4개 단축키: `Shift+Tab`, `Ctrl+Alt+M`, `Alt+T`, `Alt+X`
5. 12개 이벤트 훅 (`before_provider_request` x2, `before_agent_start`, `session_start`, `model_select`, `thinking_level_select`, `message_end`, `session_before_compact`, `session_compact`, `turn_end`, `agent_end` …)

### 상태 변이 위치 (가변 상태)
| 상태 | 변경자 | 시점 |
|---|---|---|
| `state.current` | `state.apply()` | 모드 전환 |
| `state.currentModelId/Provider` | `state.apply()`, `model_select` 훅 | 모델 변경 |
| `state.pendingPlanPath/TargetMode` | `finalize_plan` (new-session 분기) | 계획 확정 |
| `state.pendingCurrentSessionPlanBody` | `finalize_plan` (current-session 분기) | 계획 확정 (지연 디스패치용) |
| `state.compactInFlight` | `turn_end` 자동 compact 훅 | compact 진행 중 |
| 파일시스템 (modes.json, keybindings.json, settings.json) | `updateModeConfigField`, `ensureKeybindingsOverride`, `ensureQuietStartup` | session_start / `/mode-set` |

### setStatus 키 (RPC ↔ UI 계약)
- `"mode"`, `"model"`, `"thinking"`, `"overridden"` — `state.pushStatus()`
- `"context"` — `turn_end` 훅
- `"plan-handoff"` — `finalize_plan` (RPC 클라이언트 신호용)
- `"todos"` — `todo_write` 툴

---

## 3. 핵심 리팩토링 기회 (우선순위 순)

### 🔴 P0 — `index.ts` 분리 (1003 → ~200 lines)
**WHAT.** index.ts 가 너무 많은 책임을 가짐. 다음 모듈로 분리:

| 새 파일 | 옮길 코드 | 라인 추정 |
|---|---|---|
| `ui.ts` | `GLYPHS`, `renderBigText`, `centerLines`, `ansi24`, `dimText`, `fmtTokens`, `abbreviateCwd`, 배너 상수 | ~150 |
| `config-io.ts` | `ensureKeybindingsOverride`, `ensureQuietStartup`, `updateModeConfigField`, `writeExampleConfigIfMissing`, `arraysEqual` | ~170 |
| `shortcuts.ts` | `Alt+T` thinking-toggle (binary vs cycle 로직), `Alt+X` reset, `Shift+Tab` / `Ctrl+Alt+M` cycle | ~100 |
| `commands.ts` | `/mode`, `/mode-set`, `/plan-execute`, `/reset` 핸들러 | ~250 |
| `hooks.ts` | `before_provider_request` x2, `before_agent_start`, `session_start` (헤더/푸터/에디터 설정 포함), `model_select`, `thinking_level_select`, `message_end`, `turn_end`, `agent_end` | ~280 |
| `plans.ts` | `findLatestPlan`, plans 디렉토리 상수 (finalize-plan.ts 의 `uniquePlanPath` 와 통합 가능) | ~40 |
| `constants.ts` | `STATUS_KEYS`, `MODE_NAMES` (config.ts 재export), `AUTO_COMPACT_THRESHOLD`, `EXT_VERSION` 등 매직값 | ~30 |
| `index.ts` (new) | 순수 부트스트랩만 | ~80 |

**WHY.** 1003 lines 한 파일은 탐색 비용이 큼. 모듈별 분리하면 변경 영향 범위 명확.  
**RISK.** Medium — 이벤트 등록 순서·클로저 캡처 변수를 정확히 이전해야 함. 특히 `editorInstance`, `invalidateFooter`, `lastBinaryOnLevel` 클로저 변수가 함정.  
**EFFORT.** Large (~3–4 hours).

### 🔴 P0 — `STATUS_KEYS` 상수화
**WHAT.** `setStatus` 키들이 문자열 리터럴로 흩어져 있음 (`"mode"`, `"model"`, `"context"`, `"plan-handoff"`, `"todos"`, `"thinking"`, `"overridden"`).  
**WHERE.** state.ts:219–229, finalize-plan.ts:161, todo.ts:116, index.ts:750 등.  
**WHY.** 오타가 silent failure 가 됨. 정의 한 곳에 모아두면 VS Code 확장과의 RPC 계약 추적 쉬워짐.  
**RISK.** 거의 없음.  
**EFFORT.** 10분.

### 🟡 P1 — 에러 핸들링 일관성
**WHAT.** `try {} catch {}` (logging 없음) 패턴이 여기저기 있음. 디버깅 어려움.  
**WHERE.**
- [index.ts:752](index.ts#L752) `turn_end` auto-compact — 실패 시 무조건 swallow
- [index.ts:661](index.ts#L661) footer buildInfo
- [index.ts:575](index.ts#L575) session_start terminal clear
- [todo.ts:111](todo.ts#L111) sessionManager.appendEntry  
**FIX.** 최소한 `console.error("[modes:context] auto-compact failed:", err)` 정도라도 남기기. 사용자 영향 있는 부분은 `ctx.ui.notify(..., "warn")`.  
**RISK.** 매우 낮음.  
**EFFORT.** 15분.

### 🟡 P1 — 도구 핸들러 시그니처 정리
**WHAT.** `pi.registerTool()` 의 `execute: (_id, params, _signal, _onUpdate, ctx)` 5-인자 시그니처를 모든 툴에서 그대로 받고 있음. 대부분 `params` + `ctx` 만 씀.  
**WHERE.** ask-user.ts, request-mode-switch.ts, finalize-plan.ts, todo.ts.  
**FIX.** 작은 래퍼 헬퍼:
```ts
function defineTool(pi, name, def, handler) {
  pi.registerTool({ ...def, execute: (_id, params, _signal, _onUpdate, ctx) => handler(params, ctx) });
}
```
**RISK.** 낮음.  
**EFFORT.** 20분.

### 🟢 P2 — 자동 compact 임계값 magic number
[index.ts:57](index.ts#L57) `AUTO_COMPACT_THRESHOLD = 75` 는 modes.json 의 globals/system 섹션으로 옮겨도 됨. (선택사항 — 지금 동작에 문제 없음)

### 🟢 P2 — Plan 경로 통일
`findLatestPlan` (index.ts:977) 과 `uniquePlanPath` (finalize-plan.ts:35) 가 `~/.pi/agent/plans/` 를 따로 참조. `plans.ts` 로 통일.

### 🟢 P2 — auto-title.ts debug 로그 정리
[auto-title.ts:77, 81, 99, 102, 134, 145](auto-title.ts) 의 `console.error("[auto-title] ...")` 다수. 실제 에러만 남기고 informational 은 dev mode 만 또는 삭제.

### 🟢 P2 — `state.renderBox()` 의 박스 빌더 분리
[state.ts:239–289](state.ts#L239) — `buildModeBox(name)`, `buildInfoBox(cells)` 헬퍼 함수로 추출하면 가독성 ↑.

### 🟢 P2 — `any` 타입 제거
- [index.ts:122](index.ts#L122) `editorInstance: any` → 인터페이스 정의
- [index.ts:507](index.ts#L507) `ctx: any` → `ExtensionContext`
- [auto-title.ts:38](auto-title.ts#L38) `(state as any).modes?.autoTitle` → 타입 확장

---

## 4. 성능

전반적으로 hot path 가 매우 가벼움.

- **footer 렌더**: 캐시(`cachedFooterLines`, `lastWidth`)로 충분히 빠름. 변경 권장 없음.
- **auto-title**: 첫 메시지에 1회만 실행. `titledSessions` Set 중복 가드 적절.
- **turn_end**: `getContextUsage()` 두 번 호출하는 minor 패턴 ([index.ts:755, 763](index.ts#L755)). 한 번만 호출하고 변수에 담아 쓰면 됨. (영향 미미)
- **session_start 의 sync fs**: 한 번만 실행되니 문제 없음.

성능 자체로 손볼 곳은 없음. 코드 구조 정리가 더 시급.

---

## 5. 잠재 버그

1. **finalize_plan 의 새 세션 분기 setTimeout race** — `setTimeout(() => editor.onSubmit(...), 100)` 가 새 세션 boot 보다 빠르면 위험. 현재 작동하나 fragile.
2. **`turn_end` auto-compact 의 silent swallow** ([index.ts:771](index.ts#L771)) — 실패 시 사용자가 모름. notify 권장.
3. **`titledSessions` Set unbounded growth** ([auto-title.ts:10](auto-title.ts#L10)) — 한 프로세스에 10k+ 세션 누적되면 메모리 증가. 현실에선 무시 가능.
4. **`state.apply()` 의 "model not found" notify** ([state.ts:170–174](state.ts#L170)) — 사용자에게 해결 방법 안내 부족. `/mode-set` 으로 모델 설정하라는 힌트 추가 권장.

심각한 버그는 없음.

---

## 6. 행동 보존 계약 (Refactor 시 절대 깨지면 안 되는 것)

### 슬래시 커맨드
`/mode [name]`, `/mode-set`, `/plan-execute`, `/reset`

### 단축키
`Shift+Tab`, `Ctrl+Alt+M`, `Alt+T`, `Alt+X`

### 툴 이름 & 시그니처
- `ask_user(questions: [{topic, question, options: [{label, description?}]}])`
- `request_mode_switch(target_mode, reason, context_summary?)`
- `finalize_plan(summary, steps, target_mode?)`
- `todo_write(todos: [{content, status, priority}])`

### setStatus 키
`mode`, `model`, `thinking`, `overridden`, `context`, `plan-handoff`, `todos`

### 파일 경로
- 읽기/쓰기: `~/.pi/agent/modes.json`, `~/.pi/agent/modes.example.json`
- 쓰기: `~/.pi/agent/keybindings.json`, `~/.pi/agent/settings.json`, `~/.pi/agent/plans/plan-*.md`

### 이벤트 훅
`before_provider_request` x2, `before_agent_start`, `session_start`, `model_select`, `thinking_level_select`, `message_end`, `session_before_compact`, `session_compact`, `turn_end`, `agent_end`

### 모드별 도구 자동 주입
- 모든 모드: `ask_user`, `request_mode_switch`
- plan: + `finalize_plan`
- code, debug: + `todo_write`
- plan/debug/ask: `edit/write` 자동 제거

### 기본 thinking 레벨
plan/debug: high · code: medium · ask: off

### 자동 compact 임계값
75% (현재 하드코딩)

---

## 7. 권장 실행 순서

1. **상수화** (`constants.ts` + `STATUS_KEYS`) — 10분, 후속 작업 베이스
2. **헬퍼 추출** (`ui.ts`, `config-io.ts`, `plans.ts`) — 30분, 독립적
3. **이벤트 훅 추출** (`hooks.ts`) — 30분
4. **커맨드/단축키 추출** (`commands.ts`, `shortcuts.ts`) — 45분
5. **`index.ts` 슬림화** — 20분
6. **타입 강화 + 에러 핸들링** — 20분

총 예상: 2–3시간.

---

## 8. 변경하지 않을 것

- `state.ts` 의 `ModeState` 클래스 구조 — 잘 만들어져 있음
- `config.ts` — 작고 깔끔
- 툴 파일들의 핵심 로직 — 각각 단일 책임
- 시스템 프롬프트 텍스트 — 신중히 다듬은 결과물

---

## 9. 리팩토링 결과 (2026-05-25)

### 새로 추가된 모듈
| 파일 | 라인 | 역할 |
|---|---|---|
| `constants.ts` | 27 | STATUS_KEYS, AUTO_COMPACT_THRESHOLD, BINARY_THINKING_FORMATS, 배너 상수 |
| `ui.ts` | 90 | ansi24, dimText, GLYPHS, renderBigText, centerLines, fmtTokens, abbreviateCwd, buildBannerLines |
| `plans.ts` | 60 | PLANS_DIR, uniquePlanPath, findLatestPlan (finalize-plan.ts 의 path 헬퍼 통합) |
| `config-io.ts` | 179 | ensureKeybindingsOverride, ensureQuietStartup, updateModeConfigField, writeExampleConfigIfMissing, EXAMPLE_CONFIG, KEYBINDING_OVERRIDES, DESIRED_SETTINGS |
| `runtime.ts` | 34 | Runtime 컨텍스트 (editorInstance, invalidateFooter, requestRender 공유 refs) |
| `commands.ts` | 287 | /mode, /mode-set, /plan-execute, /reset (+ 공유 resetHandler) |
| `shortcuts.ts` | 120 | Shift+Tab, Ctrl+Alt+M, Alt+T (thinking toggle), Alt+X (reset) |
| `hooks.ts` | 288 | before_provider_request x2, before_agent_start, session_start (header/footer/editor), model/thinking/message_end, auto-compact, agent_end plan dispatch |

### 변경된 기존 파일
| 파일 | Before | After | 변경 |
|---|---|---|---|
| `index.ts` | 1003 | **38** | 부트스트랩만 남김 — 96% 감소 |
| `state.ts` | 304 | 304 | `STATUS_KEYS` 적용 (문자열 리터럴 → 상수) |
| `todo.ts` | 132 | 136 | `STATUS_KEYS` 적용 + 에러 로깅 추가 |
| `finalize-plan.ts` | 272 | 235 | `plans.ts` 의 `uniquePlanPath` 사용 + `STATUS_KEYS` |
| 그 외 (`config.ts`, `auto-title.ts`, `ask-user.ts`, `request-mode-switch.ts`) | — | — | 변경 없음 |

### 검증
- `tsc --noEmit` 통과 (남은 4개 에러는 **refactor 이전에도 있었던** Pi SDK `AgentToolResult<unknown>.details` strict typing 이슈 — 런타임 무관)
- 모든 setStatus 키, 슬래시 커맨드, 단축키, 툴 이름·시그니처, 파일 경로 보존

### 효과
- 가장 큰 파일이 1003 → 304 lines (state.ts) 로 감소
- index.ts 가 부트 시퀀스만 보여줌 → 새 개발자가 모듈 구조 즉시 파악
- STATUS_KEYS 상수화로 VS Code 확장과의 RPC 계약이 한 곳에서 관리됨
- 에러 핸들링: 모든 `catch {}` 가 최소한 `console.error` 로 로깅
- Pi 자체 (pi-mono) 는 건드리지 않음

### 변경하지 않은 것 (의도적)
- 도구 핸들러 시그니처 (`(_id, params, _signal, _onUpdate, ctx)` 5-인자) — 래퍼 헬퍼는 P1 으로 보류
- 미세 옵저버 패턴 (현재 ad-hoc 한 이벤트 등록이 충분히 명확)

---

## 10. Post-refactor fixes (2026-05-25 후속)

### A. `request_mode_switch` carry-over 버그 (commit 5f81153 직전)
**증상**: ask 모드에서 `request_mode_switch("debug", reason, summary)` 호출 → 승낙 → debug 모드 활성 → 그러나 follow-up 메시지가 PRE-switch 도구 (ask의 read+grep 뿐) 로 실행되어 LLM 이 "command tool 없음" 으로 오인.

**원인**: [request-mode-switch.ts](request-mode-switch.ts) 가 `pi.sendUserMessage(..., {deliverAs:"followUp"})` 로 같은 agent loop 안에 메시지 큐잉. Pi 의 `createLoopConfig` 가 `runPromptMessages` 시작 시점에 model/activeTools/systemPrompt 를 한 번만 캡처하므로, follow-up 도 PRE-switch 설정으로 실행됨. **`finalize_plan` 의 current-session 분기와 정확히 같은 안티패턴**.

**Fix**: [state.ts](state.ts) 에 `pendingModeSwitchMessage` 필드 추가 → `request_mode_switch` 가 즉시 dispatch 대신 stash → [hooks.ts](hooks.ts) 의 `agent_end` 가 새 loop 에서 dispatch (이미 plan 핸드오프용으로 같은 구조 존재).

### B. 시스템 프롬프트 — bash interpreter bypass 차단 (commit 127b049)
**증상**: plan 모드 LLM 이 `python3 - <<'PY' ... Path(...).write_text(...) ... PY` heredoc 으로 여러 소스 파일 수정. 프롬프트가 `>`, `>>`, `rm/mv/cp` 만 금지하고 인터프리터 우회를 명시 안 해서 LLM 이 "python3 는 read-only 안 적혀있음" 으로 합리화.

**Fix**: [config.ts](config.ts) plan/debug 시스템 프롬프트에 한 줄로 통합:
```
You may NOT create, modify, or delete any file by any means. This covers the
obvious (>, >>, tee, sed -i, rm/mv/cp/touch/chmod, git commit|push|reset|restore|stash|rebase)
AND interpreter bypasses where bash invokes a runtime that internally writes
(python -c, python3 - <<PY, node -e, ruby -e, perl -e, bash -c wrapping any of these).
The only file write in plan mode is the plan markdown, which finalize_plan writes for you.
```
+ 허용 목록 (cat/head/grep/find/git log...) 으로 positive reference 제공. ~6줄 추가로 모든 bypass 차단.

### C. Banner mixed-case + 색 (commits 6c50706, 375ec41)
- 기존 M 글리프 `█▄▄█/█▀▀█/█  █` 가 정사각형 박스로 H 와 시각 구분 불가 → 5-col M (`█▄ ▄█/█ ▀ █/█   █`) 로 교체
- 소문자 `h`, `m` 글리프 추가 (row 0 빈 칸 → x-height 효과) → `renderBigText` toUpperCase() 제거
- `BANNER_TEXT`: `"PI AGENT"` → `"Hmm"`, RGB: 노란색 → LED 그린 `[95, 255, 95]`
- `AUTHOR`: `"Hmm-code"` (제품명 오해) → `"lbm"` (실제 저자)

### D. 변경 요약 (commit 도착 순)
| Commit | 내용 |
|---|---|
| 7682ecd | (이전) auto-title, todo_write, refined mode prompts |
| 9719f0b | 모듈 분리 (1003 → 38 lines) + STATUS_KEYS 상수화 |
| 6c50706 | Banner mixed-case "Hmm" + 새 M 글리프 + 소문자 추가 |
| 5f81153 | (rejected, 너무 verbose) prompt bypass 차단 |
| 127b049 | 위 prompt 패치 압축 (67줄 → 30줄) |
| 375ec41 | AUTHOR "Hmm-code" → "lbm" |

---

## 11. 미해결 / 향후 개선 (P2)

- **도구 핸들러 래퍼**: `pi.registerTool` 의 `(_id, params, _signal, _onUpdate, ctx)` 5-인자 시그니처가 모든 툴에서 동일. `defineTool(pi, name, def, (params, ctx) => ...)` 헬퍼로 추출 가능.
- **타입 안전성**: `any` 타입 다수 (`editorInstance: any`, `ctx: any`, `(state as any).modes?.autoTitle` 등). 인터페이스 정의로 강화 가능.
- **auto-title.ts debug 로그**: `console.error("[auto-title] ...")` 다수 — 실제 에러만 남기고 informational 정리.
- **finalize-plan 새 세션 분기 setTimeout race**: `setTimeout(() => editor.onSubmit("/plan-execute"), 50)` 가 fragile. 더 명시적 sync 메커니즘 검토.
- **titledSessions Set unbounded growth**: 현실에선 무시 가능하지만 long-running daemon 에서는 메모리 누수.
