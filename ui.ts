// ANSI / text rendering helpers and the 3-row block-art banner glyph table.
// Pure functions — no extension state. Reused across header (banner) and
// shortcut handlers (ansi24 for editor border color comes from state.ts).

import { homedir } from "node:os";
import { BANNER_TEXT, BANNER_RGB, EXT_VERSION, AUTHOR } from "./constants";

export function ansi24(text: string, [r, g, b]: [number, number, number]): string {
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

/** ANSI faint/dim attribute — renders as muted default foreground (gray-ish). */
export function dimText(text: string): string {
	return `\x1b[2m${text}\x1b[0m`;
}

const GLYPH_HEIGHT = 3;
// 3-row block-art font. Uppercase letters fill all 3 rows; lowercase letters
// leave row 0 empty so they read at x-height next to caps (Hmm vs HMM).
// Only the glyphs actually referenced by banner/text content need to exist;
// add more if BANNER_TEXT changes.
const GLYPHS: Record<string, string[]> = {
	A: ["▄▀█", "█▀█", "█ █"],
	B: ["█▀▄", "█▀▄", "█▄▀"],
	C: ["█▀▀", "█  ", "▀▄▄"],
	D: ["█▀▄", "█ █", "█▄▀"],
	E: ["█▀▀", "█▀ ", "█▄▄"],
	F: ["█▀▀", "█▀ ", "█  "],
	G: ["█▀▀", "█▀▄", "▀▄▀"],
	H: ["█ █", "█▀█", "█ █"],
	I: ["█", "█", "█"],
	J: ["  █", "  █", "▀▄▀"],
	K: ["█ █", "█▀ ", "█ █"],
	L: ["█  ", "█  ", "█▄▄"],
	M: ["█▄ ▄█", "█ ▀ █", "█   █"],
	N: ["█▄ █", "█ ▀█", "█  █"],
	O: ["█▀█", "█ █", "▀▄▀"],
	P: ["█▀▄", "█▀ ", "█  "],
	Q: ["█▀█", "█ █", "▀▄▄"],
	R: ["█▀▄", "█▀▄", "█ ▀"],
	S: ["█▀▀", "▀▀▄", "▄▄▀"],
	T: ["▀█▀", " █ ", " █ "],
	U: ["█ █", "█ █", "▀▄▀"],
	V: ["█ █", "█ █", " █ "],
	W: ["█  █", "█▄▄█", "█▀▀█"],
	X: ["█ █", " █ ", "█ █"],
	Y: ["█ █", " █ ", " █ "],
	Z: ["▀▀█", " █ ", "█▄▄"],
	// Lowercase x-height glyphs (row 0 empty). Add as needed.
	m: ["     ", "█▀▄▀█", "█ █ █"],
	h: ["█  ", "█▀▄", "█ █"],
	" ": ["  ", "  ", "  "],
};

export function renderBigText(text: string): string[] {
	const rows: string[] = Array(GLYPH_HEIGHT).fill("");
	for (let i = 0; i < text.length; i++) {
		const ch = text[i] as string;
		// Try the literal char first (supports lowercase glyphs), then its
		// uppercase form (fallback for letters we only have caps for).
		const glyph = GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? GLYPHS[" "];
		for (let r = 0; r < GLYPH_HEIGHT; r++) {
			rows[r] += glyph[r];
			if (i < text.length - 1) rows[r] += " "; // 1-col gap between letters
		}
	}
	return rows;
}

export function centerLines(lines: string[], width: number): string[] {
	return lines.map((line) => {
		const pad = Math.max(0, Math.floor((width - line.length) / 2));
		return " ".repeat(pad) + line;
	});
}

export function fmtTokens(n: number): string {
	const K = 1024;
	const M = K * K;
	if (n >= M) return `${(n / M).toFixed(1)}M`;
	if (n >= K) return `${(n / K).toFixed(1)}K`;
	return `${n}`;
}

export function abbreviateCwd(cwd: string): string {
	const home = homedir();
	if (cwd === home) return "~";
	if (cwd.startsWith(`${home}/`)) return `~/${cwd.slice(home.length + 1)}`;
	return cwd;
}

/** Build the centered banner shown at session start. */
export function buildBannerLines(width: number): string[] {
	const banner = centerLines(renderBigText(BANNER_TEXT), width).map((l) => ansi24(l, BANNER_RGB));
	const version = dimText(centerLines([EXT_VERSION], width)[0] ?? "");
	const author = dimText(centerLines([AUTHOR], width)[0] ?? "");
	return ["", ...banner, version, author, ""];
}
