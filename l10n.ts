// Minimal dialog localization. The VS Code host passes its UI language via
// HMM_CODE_LANG ("en" | "ko") when spawning Pi (pi-launcher.ts); the TUI never
// sets it, so TUI dialogs stay English by design. Keyed by the English string
// itself so call sites stay grep-able; unknown strings pass through.
//
// Scope is deliberately tiny: the interactive dialog strings a user clicks
// (finalize_plan / finalize_implementation choices + prompts,
// request_mode_switch confirm). Notify/system lines stay English.
//
// NOTE: keep the "N. " numbering prefix on choice strings — the VS Code modal
// strips it for display (webview/modals.ts) and select() comparisons match on
// the full localized string.

const KO: Record<string, string> = {
	// finalize_plan
	"1. Execute in NEW session": "1. 새 세션에서 실행",
	"2. Execute in CURRENT session": "2. 현재 세션에서 실행",
	"3. Revise the plan": "3. 플랜 수정",
	"Plan saved →": "플랜 저장됨 →",
	"What next?": "다음으로 무엇을 할까요?",
	"How should the plan be revised?": "플랜을 어떻게 수정할까요?",
	"Type your changes…": "수정할 내용을 입력하세요…",
	// finalize_implementation
	"1. Hand off to review": "1. 리뷰로 핸드오프",
	"2. Continue implementing": "2. 구현 계속하기",
	"3. Not now": "3. 나중에",
	"Implementation complete.": "구현이 완료되었습니다.",
	"Implementation complete. What next?": "구현이 완료되었습니다. 다음으로 무엇을 할까요?",
	"What should be continued or changed?": "무엇을 더 하거나 바꿀까요?",
	"Type what's missing…": "부족한 부분을 입력하세요…",
	// request_mode_switch
	"Mode switch?": "모드를 전환할까요?",
	"Switch from {from} to {to}?": "{from} 모드에서 {to} 모드로 전환할까요?",
};

const useKo = (process.env.HMM_CODE_LANG ?? "").toLowerCase().startsWith("ko");

/** Localize a dialog string (identity in English / TUI). */
export function L(en: string): string {
	return useKo ? (KO[en] ?? en) : en;
}

/** Localize a template with {param} substitution. */
export function Lf(en: string, params: Record<string, string>): string {
	let s = L(en);
	for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, v);
	return s;
}
