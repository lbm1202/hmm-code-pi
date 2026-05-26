// Keyboard shortcuts: mode cycle (Tab, Ctrl+Alt+M), thinking toggle
// (Alt+T) and reset (Alt+X).

import { Key } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MODE_NAMES } from "./config";
import { BINARY_THINKING_FORMATS } from "./constants";
import { resetHandler } from "./commands";
import type { Runtime } from "./runtime";

const CYCLE_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
type BinaryOnLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

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

	// Alt+T thinking-toggle state lives in closure so back-to-back toggles
	// remember the last "on" level for binary models.
	let lastBinaryOnLevel: BinaryOnLevel = "medium";
	pi.registerShortcut(Key.alt("t"), {
		description: "Toggle thinking (binary for Qwen-style, cycle for others)",
		handler: async (ctx) => {
			try {
				await handleThinkingToggle(rt, ctx, (next) => {
					if (next !== undefined) lastBinaryOnLevel = next;
				}, lastBinaryOnLevel);
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
}

async function handleThinkingToggle(
	rt: Runtime,
	ctx: ExtensionContext,
	rememberOnLevel: (level: BinaryOnLevel | undefined) => void,
	lastBinaryOnLevel: BinaryOnLevel,
): Promise<void> {
	const { pi } = rt;
	const model = ctx.model as
		| {
				reasoning?: boolean;
				compat?: { thinkingFormat?: string };
				thinkingLevelMap?: Record<string, unknown>;
		  }
		| undefined;
	if (!model) {
		ctx.ui.notify("No model selected; thinking toggle skipped.", "warning");
		return;
	}
	if (!model.reasoning) {
		ctx.ui.notify("Model does not support thinking. Toggle skipped.", "warning");
		return;
	}

	const map = model.thinkingLevelMap ?? {};
	const supportedAll =
		Object.keys(map).length > 0
			? (CYCLE_LEVELS as readonly string[]).filter((lvl) => map[lvl] !== null)
			: ([...CYCLE_LEVELS] as string[]);
	if (supportedAll.length === 0) {
		ctx.ui.notify("Model has no supported thinking levels.", "warning");
		return;
	}

	const fmt = model.compat?.thinkingFormat;
	const isBinary = fmt && BINARY_THINKING_FORMATS.has(fmt);
	const current = pi.getThinkingLevel();

	if (isBinary) {
		const nonOff = supportedAll.filter((l) => l !== "off");
		if (nonOff.length === 0) {
			ctx.ui.notify("Binary model has no 'on' level configured.", "warning");
			return;
		}
		if (current === "off") {
			const target = nonOff.includes(lastBinaryOnLevel)
				? lastBinaryOnLevel
				: (nonOff[0] as BinaryOnLevel);
			pi.setThinkingLevel(target);
		} else {
			if (nonOff.includes(current as string)) {
				rememberOnLevel(current as BinaryOnLevel);
			}
			pi.setThinkingLevel("off");
		}
	} else {
		const idx = supportedAll.indexOf(current as string);
		const next = supportedAll[(idx + 1) % supportedAll.length] as BinaryOnLevel | "off";
		pi.setThinkingLevel(next);
	}

	rt.invalidateFooter?.();
	rt.requestRender();
}
