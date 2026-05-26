# Workflow

이 확장의 핵심 가정: **모든 코드 수정 경로는 반드시 `plan → code`** 를
거친다. 다른 모드 (debug/ask) 는 plan 의 입력 context 를 풍부하게 하는
사전 단계.

```
ask ───────────────► request_mode_switch("plan", reason, summary)
                                                                  \
debug ─────────────► request_mode_switch("plan", reason, summary) ─► plan ─► finalize_plan ─► code
                                                                  /                       (new-session OR current-session)
plan ───────────────────────────────────────────────────────────/
```

---

## 1. 모드 전환 메커니즘

### 사용자 명시 전환
- 슬래시: `/mode code`, `/mode plan`, `/mode debug`, `/mode ask`
- 슬래시 인자 없음: `/mode` → picker (4개 모드 + 현재 모드 표시)
- 단축키 (TUI): `Tab` / `Ctrl+Alt+M` 순환 (`Shift+Tab` 은 Pi autocomplete)
- VS Code: 푸터의 mode picker 클릭

전환 즉시 `state.apply(name)` → 모델/thinking/activeTools 갱신 + system
prompt addendum 다시 합성 (`before_agent_start` 다음 호출 때).

### LLM 제안 전환 (request_mode_switch)
LLM 이 `request_mode_switch(target_mode, reason, context_summary)` 호출
→ 사용자 confirm 다이얼로그 → 승낙 시 자동 전환.

**전환 트리거 시점 (시스템 프롬프트에 명시)**:
- 사용자가 명시적으로 계획 작성 의향 표현 ("이제 계획 짜자" 등)
- 또는 현재 모드 작업이 자연스러운 종결점 도달 (debug 는 진단 완료,
  ask 는 충분한 설명 완료)

작업 도중 조급하게 부르지 말 것 — 시스템 프롬프트에 가드 명시.

**제약**:
- `target_mode === currentMode` → isError + "이미 해당 모드" 반환
- `target_mode === "code"` → isError + "finalize_plan 통해서만 가능"
  반환 (`code` 진입은 finalize_plan 단독 경로)
- 헤드리스 (`!ctx.hasUI`) → isError 즉시 반환

---

## 2. plan → code 핸드오프 (finalize_plan)

plan 모드의 유일한 mutating 도구. 호출 시 3개 분기 다이얼로그:

> **Finalize plan**
>
> 계획 검토 후 다음 단계를 선택:
>
> - **[A]** 새 세션에서 code 모드로 실행 *(권장)*
> - **[B]** 현재 세션에서 code 모드로 전환
> - **[C]** 계획 수정 (자유 입력)
>
> Esc: 보류 (계획 파일은 저장됨)

`.pi/plans/plan-<adjective>-<noun>.md` 항상 저장. 모든 분기에서 동일 —
취소해도 파일은 남음.

### 스키마

```ts
finalize_plan({
  summary: string,             // 필수. 1-2 문장. 다이얼로그/picker preview
  body: string,                // 필수. 자유 markdown (### 이하만). 현재 상태 / 파일 구조 / 데이터 모델 / 전략 / 리스크 등
  steps: string[],             // 필수. 실행 순서 (LLM 이 따라갈 체크리스트)
  validation: string[],        // 필수. 검증 명령 / 시나리오. trivial 이면 "No verification needed — ..." 한 줄
  docs?: string[],             // 선택. 갱신할 문서 (예: "README.md: Setup 섹션")
  target_mode?: "code" | "debug",
})
```

### 출력 마크다운

```markdown
# Plan
- Created: ... / Target mode: ... / Source model: ...

## Summary
{summary}

## Design        ← body 가 있을 때만 (스키마 필수라 거의 항상)
{body}           ← LLM 이 ### 이하로 작성. ## 쓰면 Summary/Steps 와 같은 레벨이 돼 깨짐

## Steps
1. ...

## Validation    ← validation 이 있을 때만 (필수라 항상)
- ...

## Documentation ← docs 가 있을 때만 (optional)
- ...
```

VS Code 의 finalize_plan 인라인 미리보기 ([tools.ts:renderFinalizePlanPreview](https://github.com/lbm1202/hmm-code-vscode/blob/main/webview/tools.ts))
가 같은 구조로 렌더 — 다이얼로그 뜬 상태에서 사용자가 본문 확인 가능.

### A. 새 세션
1. plan 파일 저장
2. `ctx.newSession({ parentSession, withSession })` 으로 새 세션 spawn
3. 새 세션에서 `applyMode("code")` 호출
4. 첫 사용자 메시지로 plan 원문 주입 ("다음 계획을 그대로 구현하세요…")
5. parent session 과 picker tree 에서 자동 연결됨

### B. 현재 세션
1. plan 파일 저장
2. `state.apply("code", ctx)` — 모드 전환
3. `state.pendingCurrentSessionPlanBody = planBody` 로 stash
4. **`terminate: true` 반환** → 현재 agent loop 종료
5. `agent_end` 훅이 발화하면서 stash 된 body 를 `pi.sendUserMessage(...)`
   로 dispatch → 새 agent loop 가 시작되며 첫 메시지로 plan 받음

**왜 stash 가 필요한가**: Pi 의 `createLoopConfig` 가 model/thinking/
activeTools 를 loop 시작 시점에 캡처. 같은 loop 안에서 `applyMode` 해도
이미 잡힌 config 가 따라옴. 그래서 `terminate` 로 loop 끊고, 다음 loop
에서 새 config 가 잡히도록 deferred dispatch.

### C. 수정
1. plan 파일 저장
2. `ctx.ui.input(...)` 으로 자유 입력 받음
3. 입력 내용을 tool result 로 LLM 에 전달 ("사용자가 다음과 같이 수정
   요청…")
4. plan 모드 유지 → LLM 이 계획 재작성 + finalize_plan 재호출

---

## 3. debug / ask → plan 핸드오프

`request_mode_switch("plan", reason, context_summary)` 호출.

```ts
state.pendingModeSwitchMessage =
    `Carry-over from ${origin} mode:\n${params.context_summary.trim()}\n\nPlease continue.`;
```

`finalize_plan` 의 분기 B 와 똑같은 이유로 stash + agent_end dispatch.
이렇게 안 하면 carry-over 메시지가 PRE-switch 의 model/tools 로 보내짐.

`agent_end` 훅:
```ts
const body = state.pendingCurrentSessionPlanBody ?? state.pendingModeSwitchMessage;
if (!body) return;
state.pendingCurrentSessionPlanBody = undefined;
state.pendingModeSwitchMessage = undefined;
setImmediate(() => pi.sendUserMessage(body));
```

---

## 4. 모드별 도구 + 시스템 프롬프트

| Mode | activeTools (LLM 노출) | systemPromptAddendum 핵심 |
|---|---|---|
| **plan** | read, grep, find, ls, bash, **ask_user, request_mode_switch, finalize_plan** | 3 phase: 조사 → 설계+질문 → finalize_plan. write/edit 금지 + interpreter bypass 가드. ask_user 로 결정, finalize_plan 으로 종결 |
| **code** | read, edit, write, bash, grep, find, ls, **ask_user, request_mode_switch, todo_write** | 계획대로 구현. ask_user 는 진짜 갈래에만. todo_write 적극 활용 (3+ 스텝, 사용자 list, plan handoff) |
| **debug** | read, bash, grep, find, ls, **ask_user, request_mode_switch, todo_write** | 가설→재현→로그 분석. edit/write 금지 (+ interpreter bypass 가드). 조급한 request_mode_switch 금지 |
| **ask** | read, grep, **ask_user, request_mode_switch** | 설명 위주. 도구 호출 최소. 사용자 명시 시점에만 plan 전환 제안 |

`edit`/`write` 는 plan/debug/ask 에서 자동 제거됨 (`state.ts:PROTECTED_FROM_NON_CODE`).
사용자가 modes.json 에 추가해도 무시 + 경고.

---

## 5. 같은 세션 안에서 모드 바뀔 때 캡처 이슈

### 문제
Pi 의 agent loop (`runPromptMessages`) 가 시작 시 다음을 캡처:
- 활성 모델 + thinkingLevel
- 활성 도구 목록
- systemPrompt

같은 loop 안에서 `applyMode` 호출 → state 는 업데이트, 하지만 이번 loop
는 PRE-apply 캡처 그대로 사용. follow-up 메시지가 옛 설정으로 처리됨.

### 해결
mode-switch 가 일어날 만한 분기마다 `terminate: true` 반환 → loop 종료
→ 다음 loop (다음 사용자 메시지 또는 deferred dispatch) 에서 새 캡처.

해당 도구:
- `finalize_plan` (B 분기)
- `request_mode_switch` (승낙 시)

stash → agent_end → dispatch 패턴.

---

## 6. 세션 lifecycle 이벤트

| 이벤트 | 시점 | 우리 핸들러에서 하는 일 |
|---|---|---|
| `session_start` | 매 세션 시작 (startup / reload / new / resume / fork) | `loadModes`, AGENTS.md re-eval, mode 복원 (`restoreFromSession`), keybindings/settings 자동 install, **auto-approve OFF 리셋** |
| `before_agent_start` | 매 user prompt cycle 시작 (= `runPromptMessages` 호출) | system prompt 합성: base + mode addendum + AGENTS.md (global → project) |
| `agent_start` | (위 직후) | (Pi 내부) |
| `before_provider_request` | 매 LLM API 호출 직전 | mode 의 temperature / chatTemplate 주입, Qwen `enable_thinking` 보조 |
| `tool_call` | LLM 의 모든 도구 호출 직전 | **권한 평가** (.piignore → layered rules → ask/allow/deny), auto-approve 시 ask 통과 |
| `tool_execution_start/update/end` | 도구 실행 phase | (Pi 내부) |
| `message_end` | LLM 메시지 1개 완료 | 자동 제목 생성 (첫 user→assistant pair, session 별 1회) |
| `agent_end` | user prompt cycle 끝 | **deferred dispatch** (pendingCurrentSessionPlanBody / pendingModeSwitchMessage 있으면 `pi.sendUserMessage`) |

---

## 7. 세션 manager / picker

세션 파일: `~/.pi/<workspace-hash>/sessions/<timestamp>_<rand>.jsonl`

- 새 세션: `/new-session` 또는 VS Code 의 ⊕ 버튼
- 세션 picker: 부모-자식 tree (finalize_plan 의 new-session 분기로 만들어진
  자식 세션은 부모와 묶임)
- 이름 변경: sidecar `.pi-modes-names.json` 에 저장 (Pi session 파일은
  immutable)
- 삭제: 단일 + 자식 cascade. **활성 세션 삭제 시 자동으로 새 세션
  spawn** (VS Code: ChatBackend 의 DELETE_SESSION 핸들러 처리)

---

## 8. 모델 / Thinking / Override

`/mode` 전환 시 mode 의 default model + thinking 적용. 사용자가 picker
로 다른 값 선택하면 "overridden" 상태 → 푸터에 `Alt+X → default` 셀
표시.

`Alt+X` (`/reset` 슬래시) → mode default 로 복원.

`auto-title` 모델은 별도. 첫 메시지 페어 끝나면 작은 GPT-mini 모델로
세션 제목 생성. modes.json 의 `autoTitle.{provider,id}` 에서 override
가능.

---

## 9. 권한 시스템

별도 문서: [PERMISSIONS.md](./PERMISSIONS.md).

핵심:
- Layer 1 = `activeTools` (모드별 도구 종류)
- Layer 2 = path/bash 룰 (BASE_DEFAULTS + MODE_DEFAULTS + 사용자
  global/project + .piignore)
- Auto-approve 토글로 세션 한정 ask 통과

---

## 10. AGENTS.md

별도 문서: [AGENTS-MD.md](./AGENTS-MD.md).

핵심: `${cwd}/AGENTS.md` + `~/.pi/agent/AGENTS.md` 가 있으면 매 user
prompt cycle 의 system prompt 끝에 자동 append.
