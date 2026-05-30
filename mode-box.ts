// Pure rendering of the mode/model footer box (TUI). Extracted from ModeState
// so the dense terminal-width layout logic is testable in isolation — it takes
// plain inputs and returns the ANSI lines; no state, no Pi handles.

import { MODE_NAMES, type ModeName } from "./config";
import { ansi24 } from "./ui";

const MODE_COLORS: Record<ModeName, [number, number, number]> = {
	plan: [100, 150, 255], // blue
	code: [240, 240, 240], // white
	debug: [180, 120, 220], // purple
	ask: [255, 165, 80], // orange
};
// max name length + 1 → 2 of 4 names get perfect centering (code/plan with len 4),
// ask/debug end up 1 cell off. Pure-center for all 4 isn't possible with monospace
// when name lengths have mixed parity.
const MODE_FIELD_WIDTH = Math.max(...MODE_NAMES.map((n) => n.length)) + 1;

export function modeColor(name: ModeName): [number, number, number] {
	return MODE_COLORS[name];
}

function centerText(text: string, width: number): string {
	const diff = Math.max(0, width - text.length);
	const left = Math.floor(diff / 2);
	const right = diff - left;
	return " ".repeat(left) + text + " ".repeat(right);
}

export interface ModeBoxInput {
	mode: ModeName;
	modelLabel: string;
	thinkingLevel: string | number | undefined;
	autoApprove: boolean;
	overridden: boolean;
	/** Terminal width. */
	width: number;
	/** Right-hand box2 cells (token/context info); empty entries are dropped. */
	info: string[];
}

export function renderModeBox(input: ModeBoxInput): string[] {
	const { mode, modelLabel, thinkingLevel, autoApprove, overridden, width, info } = input;
	const rgb = MODE_COLORS[mode];
	const white: [number, number, number] = [240, 240, 240];

	// Box 1: open-left mode trough + model cell, optionally + auto-approve and
	// override hint cells. Colored per mode. Optional cells are dropped when the
	// terminal is too narrow to fit them alongside box2 (token info) — essential
	// cells (mode/model/thinking) always render.
	const modeInner = ` ${centerText(mode, MODE_FIELD_WIDTH)} `;
	const modelInner = ` ${modelLabel} `;
	const thinkingInner = ` ${thinkingLevel} `;

	// Pre-build box2 so we know its width when deciding which box1 cells fit.
	const cells = info.filter((s) => s && s.length > 0).map((s) => ` ${s} `);
	const buildBox = (innerCells: string[]) => {
		const dashes = innerCells.map((c) => "─".repeat(c.length));
		return {
			top: `┌${dashes.join("┬")}┐`,
			mid: `│${innerCells.join("│")}│`,
			bot: `└${dashes.join("┴")}┘`,
			width: dashes.reduce((n, d) => n + d.length, 0) + dashes.length + 1,
		};
	};
	let box2: { top: string; mid: string; bot: string; width: number } | undefined;
	if (cells.length > 0) box2 = buildBox(cells);

	const usable = Math.max(0, width - 1); // -1 for Pi's hardcoded 1-col padding
	const minGap = 2;

	// Try most-detailed box1, fall back progressively if too wide for box2.
	const candidates = [
		[modeInner, modelInner, thinkingInner, autoApprove ? " auto-approve " : "", overridden ? " Alt+X → default " : ""].filter((c) => c.length > 0),
		[modeInner, modelInner, thinkingInner, autoApprove ? " ✓auto " : "", overridden ? " ✱ " : ""].filter((c) => c.length > 0),
		[modeInner, modelInner, thinkingInner],
	];
	let box1Cells = candidates[0];
	for (const cand of candidates) {
		const w = cand.reduce((n, c) => n + c.length, 0) + cand.length;
		if (!box2 || w + box2.width + minGap <= usable) {
			box1Cells = cand;
			break;
		}
	}
	const box1Dashes = box1Cells.map((c) => "─".repeat(c.length));
	const box1Top = `${box1Dashes.join("┬")}┐`;
	const box1Mid = `${box1Cells.join("│")}│`;
	const box1Bot = `${box1Dashes.join("┴")}┘`;
	const box1Width = box1Top.length;

	if (!box2) {
		return [ansi24(box1Top, rgb), ansi24(box1Mid, rgb), ansi24(box1Bot, rgb)];
	}

	// If even the minimal box1 + box2 + min gap doesn't fit, drop box2 rather
	// than letting them overlap. Box1 has the essential state.
	if (box1Width + box2.width + minGap > usable) {
		return [ansi24(box1Top, rgb), ansi24(box1Mid, rgb), ansi24(box1Bot, rgb)];
	}

	// Right-align box2: spacer fills the gap between box1 and the right edge.
	const gap = " ".repeat(Math.max(minGap, usable - box1Width - box2.width));

	return [
		ansi24(box1Top, rgb) + gap + ansi24(box2.top, white),
		ansi24(box1Mid, rgb) + gap + ansi24(box2.mid, white),
		ansi24(box1Bot, rgb) + gap + ansi24(box2.bot, white),
	];
}
