# Hmm-code (Pi extension)

Pi-side of **Hmm-code** — a multi-mode wrapper for the
[Pi coding agent](https://github.com/badlogic/pi-mono).
4개 명시적 모드 — **plan / code / debug / ask** — 각자 모델/thinking/도구
/system prompt 를 독립 운영. 모든 코드 수정 경로는 반드시 `plan → code`.

VS Code UI (`pi --mode rpc` wrapper) 는 자매 repo
[hmm-code-vscode](https://github.com/lbm1202/hmm-code-vscode).

---

## 한눈에

| 기능 | 요약 |
|---|---|
| **4 모드** | plan / code / debug / ask — 모드별 model + thinking + 도구 + system prompt |
| **finalize_plan** | plan → code 핸드오프 (new session / current session / revise 3분기). 스키마: `summary` + `body` + `steps` + `validation` + `docs?` |
| **request_mode_switch** | LLM 이 모드 전환 제안 → 사용자 confirm → 자동 전환 |
| **권한 시스템** | tool_call 훅에서 path/bash 패턴 평가 (Kilo-aligned) — `~/.pi/agent/permissions.json` + `.piignore` |
| **auto-approve** | 세션 한정 토글 — ask 자동 통과 (CLI 슬래시 + VS Code 인라인 버튼) |
| **AGENTS.md** | `${cwd}/AGENTS.md` + `~/.pi/agent/AGENTS.md` 자동 주입 |
| **toolCall sanitize** | 로컬 모델 (Qwen vLLM 등) 의 망가진 tool name 자동 정화 → codex hard-stuck 방지 |
| **자동 제목** | 첫 메시지 페어 후 GPT-mini 로 세션 제목 생성 |
| **자동 컴팩트** | 75% 컨텍스트 도달 시 자동 compact |

---

## 설치

```bash
mkdir -p ~/.pi/agent/extensions
git clone https://github.com/lbm1202/hmm-code-pi ~/.pi/agent/extensions/modes
```

Pi 가 다음 시작 시 자동 로드. 첫 실행에 다음 파일들 자동 생성:
- `~/.pi/agent/modes.example.json` — 모드 설정 템플릿
- `~/.pi/agent/permissions.example.json` — 권한 룰 템플릿
- `~/.pi/agent/keybindings.json` — Tab(모드 순환) / Shift+Tab(autocomplete) / Alt+T / Alt+X 자동 install
- `~/.pi/agent/settings.json` — quietStartup, hideThinkingBlock

---

## 모드 요약

| Mode  | LLM 도구 (config) | 자동 주입 | 권한 layer 2 | 용도 |
|-------|------------------|-----------|--------------|------|
| plan  | read, grep, find, ls, bash | ask_user, request_mode_switch, **finalize_plan** | bash → readOnlyBash, edit/write `.pi/plans/*.md` 만 | 조사 + 설계 + finalize_plan |
| code  | read, edit, write, bash, grep, find, ls | ask_user, request_mode_switch, todo_write | base defaults (bash 안전명령 allow, 위험 ask) | 실제 코드 작성 |
| debug | read, bash, grep, find, ls | ask_user, request_mode_switch, todo_write | base defaults (debug 는 free shell) | 재현 + 진단 + 가설 검증 |
| ask   | read, grep | ask_user, request_mode_switch | bash → readOnlyBash, edit/write deny | 설명 + Q&A |

`edit`/`write` 는 plan/debug/ask 에서 자동 제거됨 — 사용자가 modes.json
에 추가해도 무시 + 경고.

워크플로우 다이어그램은 [docs/WORKFLOW.md](docs/WORKFLOW.md) 참조.

---

## 문서

| 문서 | 내용 |
|---|---|
| [docs/WORKFLOW.md](docs/WORKFLOW.md) | 모드 전환 / finalize_plan / agent_end deferred dispatch / 세션 lifecycle |
| [docs/PERMISSIONS.md](docs/PERMISSIONS.md) | 권한 시스템 전체 — 룰 문법, 빌트인, 사용자 설정, 예시 |
| [docs/AGENTS-MD.md](docs/AGENTS-MD.md) | AGENTS.md 자동 주입 메커니즘 |
| [docs/ANALYSIS.md](docs/ANALYSIS.md) | 파일별 deep-dive + 리팩토링 히스토리 |

---

## 슬래시 명령

| 명령 | 설명 |
|---|---|
| `/mode [name]` | picker 또는 직접 전환 |
| `/mode-set` | 모드별 model + thinking 인터랙티브 편집 (auto-reload) |
| `/plan-execute` | 가장 최근 plan 을 새 child 세션에서 실행 |
| `/reset` | model + thinking 을 현재 모드의 default 로 복원 (Alt+X 와 동일) |
| `/auto-approve [on\|off]` | 권한 ask 자동 통과 토글 (세션 한정) |
| `/reload-runtime` | 확장/설정/모델 reload (RPC-safe, built-in `/reload` 대체) |

---

## 단축키 (TUI)

| 키 | 동작 |
|---|---|
| `Tab` / `Ctrl+Alt+M` | 모드 순환 (code → plan → debug → ask). `Shift+Tab` = Pi 자동완성 |
| `Alt+T` | thinking 레벨 토글 (provider-aware) |
| `Alt+X` | model + thinking 을 모드 default 로 reset |

`Alt+T`:
- Qwen-style binary providers (`qwen-chat-template`, `zai`): off/on
- Reasoning models (GPT-5, Claude 등): off / minimal / low / medium / high cycle

---

## 설정 파일

| 경로 | 내용 |
|---|---|
| `~/.pi/agent/modes.json` | 모드별 model/thinking/activeTools/systemPromptAddendum/temperature/chatTemplate, modelAliases, autoTitle 모델, modelAllowlist |
| `~/.pi/agent/permissions.json` | 권한 룰 (글로벌). 자세히는 [docs/PERMISSIONS.md](docs/PERMISSIONS.md) |
| `${cwd}/.pi/permissions.json` | 권한 룰 (프로젝트별, 글로벌 override) |
| `${cwd}/.piignore` | gitignore-style 차단 (모든 도구 deny) |
| `${cwd}/AGENTS.md` | 프로젝트 컨텍스트 (system prompt 자동 주입) |
| `~/.pi/agent/AGENTS.md` | 글로벌 컨텍스트 |
| `~/.pi/agent/plans/` | finalize_plan 결과물 저장 |

---

## 핵심 불변 조건

1. **write/edit 권한은 오직 code 모드** — plan/debug/ask 의 activeTools
   에서 자동 제거 (`state.ts:PROTECTED_FROM_NON_CODE`)
2. **finalize_plan 은 오직 plan 모드** — code 진입의 유일한 명시적 경로
3. **request_mode_switch("code") 금지** — code 는 finalize_plan 통해서만
4. **시스템 path 작업도 권한 layer 통과** — `~/.ssh`, `/etc` 등 외부
   디렉터리 ask 또는 deny

---

## 파일 구조

```
~/.pi/agent/extensions/modes/
├── index.ts             # 부팅 — Runtime 만들고 tools/commands/shortcuts/hooks 등록
├── config.ts            # 모드 스키마 + loadModes + DEFAULT_MODES (system prompts)
├── constants.ts         # STATUS_KEYS, AUTO_COMPACT_THRESHOLD, 버전/저자 single source
├── runtime.ts           # 공유 Runtime context (editor ref + footer invalidator)
├── ui.ts                # ANSI/banner 헬퍼, mixed-case "Hmm" glyph table
├── plans.ts             # ~/.pi/agent/plans/ 경로 + unique name 생성
├── config-io.ts         # modes.json / keybindings.json / settings.json I/O
├── state.ts             # ModeState (apply/reset/footer), pushStatus for RPC
├── commands.ts          # /mode, /mode-set, /plan-execute, /reset, /reload-runtime, /auto-approve
├── shortcuts.ts         # Tab, Ctrl+Alt+M, Alt+T, Alt+X
├── hooks.ts             # session_start, before_agent_start (AGENTS.md), before_provider_request, agent_end (deferred dispatch)
├── ask-user.ts          # multi-question card tool
├── request-mode-switch.ts  # 모드 전환 제안 (carry-over deferred)
├── finalize-plan.ts     # plan commit + 3분기 다이얼로그
├── todo.ts              # OpenCode/Kilo style todo_write
├── auto-title.ts        # 첫 메시지 페어 후 GPT-mini 세션 제목 생성
└── permissions/         # 권한 시스템 (자세히 docs/PERMISSIONS.md)
    ├── index.ts         # tool_call 훅 + 평가 진입점
    ├── defaults.ts      # BASE_DEFAULTS + MODE_DEFAULTS
    ├── bash-rules.ts    # BASH_DEFAULT + BASH_READ_ONLY (Kilo MIT 차용)
    ├── evaluator.ts     # layer merge + strongest verdict
    ├── glob.ts          # 경량 minimatch (path mode + shell mode)
    ├── piignore.ts      # .piignore 파서
    ├── extract-paths.ts # 도구별 path 추출
    ├── loader.ts        # JSON 디스크 로더 (mtime 캐시)
    └── types.ts         # Verdict / Permissions / Ruleset 스키마
```

---

## License

Personal use. Bash rule patterns adapted from [Kilo Code](https://github.com/Kilo-Org/kilocode) (MIT).
