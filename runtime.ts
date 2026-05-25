// Shared mutable context wired by index.ts at boot and consumed by
// commands/shortcuts/hooks. Holds the bits index.ts used to keep as
// function-scoped closure variables (editor instance, footer invalidator).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModeState } from "./state";

export interface Runtime {
	pi: ExtensionAPI;
	state: ModeState;
	/** Set by hooks.ts in session_start; consumed by shortcuts/commands. */
	editorInstance: any;
	/** Set by hooks.ts when the footer factory runs. Flush footer cache. */
	invalidateFooter?: () => void;
	/** Re-render TUI editor; no-op when editor not yet created. */
	requestRender(): void;
}

export function createRuntime(pi: ExtensionAPI, state: ModeState): Runtime {
	const rt: Runtime = {
		pi,
		state,
		editorInstance: undefined,
		invalidateFooter: undefined,
		requestRender() {
			rt.editorInstance?.tui?.requestRender?.();
		},
	};
	state.onApply = () => {
		rt.invalidateFooter?.();
		rt.requestRender();
	};
	return rt;
}
