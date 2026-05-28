// Keyboard shortcuts: mode cycle (Tab, Ctrl+Alt+M), thinking toggle
// (Alt+T), reset (Alt+X), auto-approve toggle (Ctrl+Shift+A).

import { Key } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODE_NAMES } from "./config";
import { autoApproveHandler, resetHandler, thinkingToggleHandler } from "./commands";
import type { Runtime } from "./runtime";

export function registerShortcuts(rt: Runtime): void {
	const { pi, state } = rt;

	const cycleMode = async (ctx: ExtensionContext) => {
		const idx = MODE_NAMES.indexOf(state.current);
		const next = MODE_NAMES[(idx + 1) % MODE_NAMES.length];
		await state.apply(next, ctx);
	};

	// Tab cycles modes. Pi's built-in autocomplete (tui.input.tab) is
	// reassigned to Shift+Tab via the keybindings override (config-io.ts).
	// Pi's default Shift+Tab → app.thinking.cycle is moved to Ctrl+Shift+T
	// by the same override.
	pi.registerShortcut(Key.tab, {
		description: "Cycle mode (code → plan → debug → ask)",
		handler: cycleMode,
	});
	pi.registerShortcut(Key.ctrlAlt("m"), {
		description: "Cycle mode (alt binding)",
		handler: cycleMode,
	});

	pi.registerShortcut(Key.alt("t"), {
		description: "Toggle thinking (binary for Qwen-style, cycle for others)",
		handler: async (ctx) => {
			try {
				await thinkingToggleHandler(rt, ctx);
			} catch (err) {
				console.error("[modes:shortcuts] Alt+T thinking toggle failed:", err);
				ctx.ui.notify(`Alt+T failed: ${err}`, "error");
			}
		},
	});

	pi.registerShortcut(Key.alt("x"), {
		description: "Reset model + thinking to current mode's defaults",
		handler: async (ctx) => resetHandler(rt, ctx),
	});

	pi.registerShortcut(Key.ctrlShift("a"), {
		description: "Toggle auto-approve (session bypass for permission ask)",
		handler: async (ctx) => autoApproveHandler(rt, ctx, ""),
	});
}
