// Structural-whitespace-tolerant reconciliation for the edit tool, plus a
// visible-whitespace failure hint. Weak local models (Qwen et al.) get code
// CONTENT right but structural whitespace wrong — most often a whole-block
// indentation shift (oldText authored at 8-space indent when the file uses 4).
// Pi's built-in fuzzy match (edit-diff.js) only tolerates TRAILING whitespace +
// unicode lookalikes, so a leading-indent shift falls through to "Could not find
// the exact text", and the model abandons `edit` for opaque `bash python3`
// heredoc writes (observed in real sessions).
//
// Two cooperating pieces, wired in hooks.ts:
//   - reconcileEditInput (tool_call hook): when oldText doesn't match exactly,
//     locate it by DEDENT-anchored comparison — both sides reduced by their own
//     minimum common indent (blank lines excluded), then compared VERBATIM so
//     relative structure is still verified. On a UNIQUE match, rewrite oldText to
//     the file's exact bytes and shift newText by the same indentation delta.
//     Conservative by design: bails (leaves input untouched) on zero/multiple
//     matches, mixed tab+space indent, or a tab/space mismatch that would force
//     it to guess an indent character — so it never edits the wrong place.
//   - buildEditFailureHint (tool_result hook): on a still-failing edit, append
//     the model's oldText and the closest file region with whitespace made
//     visible (· space, → tab) so the model self-corrects instead of shelling
//     out. Reports multiple candidate locations when the text is ambiguous.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VIS_SPACE = "·";
const VIS_TAB = "→";

// Matches Pi's paths.js UNICODE_SPACES (kept in sync so reconcile resolves the
// same file Pi will edit).
const UNICODE_SPACES = new RegExp("[\u00A0\u2000-\u200A\u202F\u205F\u3000]", "g");

interface NormEdit {
	oldText: string;
	newText: string;
}

interface DedentInfo {
	/** Minimum common leading-indent width (chars; tab counts as 1) over non-blank lines. */
	base: number;
	/** Each line, trailing-trimmed and dedented by `base`. Blank lines → "". */
	rel: string[];
	/** Indent character consensus over non-blank lines' leading whitespace. */
	char: "space" | "tab" | "mixed" | "none";
}

function toLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripBom(text: string): string {
	return text.startsWith("﻿") ? text.slice(1) : text;
}

/** Resolve a tool path the way Pi's resolveToCwd does — normalize unicode
 *  spaces, strip a leading "@", expand "~", handle file:// URLs — so reconcile +
 *  the failure hint read the SAME file Pi will edit. (Diverging here silently
 *  no-ops the feature on "@path" / "~/path" inputs.) */
function resolveCwd(path: string, cwd: string | undefined): string {
	let p = path.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = homedir();
	else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	else if (/^file:\/\//.test(p)) {
		try {
			p = fileURLToPath(p);
		} catch {
			/* leave as-is on a malformed file URL */
		}
	}
	return isAbsolute(p) ? resolve(p) : resolve(cwd ?? process.cwd(), p);
}

function leadWs(line: string): string {
	const m = /^[ \t]*/.exec(line);
	return m ? m[0] : "";
}

function isBlank(line: string): boolean {
	return /^[ \t]*$/.test(line);
}

/** Reduce a block to its dedented comparison form. Trailing whitespace is
 *  trimmed per line; the baseline indent is the minimum over NON-BLANK lines
 *  (blank lines are excluded so they don't drag the baseline to zero); every
 *  line then has `base` leading chars removed. Blank lines collapse to "".
 *  Returns null when the block is entirely blank. */
function dedentForCompare(lines: string[]): DedentInfo | null {
	let base = Infinity;
	let sawTab = false;
	let sawSpace = false;
	for (const raw of lines) {
		if (isBlank(raw)) continue;
		const ws = leadWs(raw);
		if (ws.includes("\t")) sawTab = true;
		if (ws.includes(" ")) sawSpace = true;
		if (ws.length < base) base = ws.length;
	}
	if (!isFinite(base)) return null;
	const rel = lines.map((raw) => {
		const trimmed = raw.replace(/[ \t]+$/, "");
		return isBlank(trimmed) ? "" : trimmed.slice(base);
	});
	const char = sawTab && sawSpace ? "mixed" : sawTab ? "tab" : sawSpace ? "space" : "none";
	return { base, rel, char };
}

/** All window start indices in `fileLines` whose dedented form equals `oldRel`,
 *  capped at `maxHits` (callers only distinguish 0 / 1 / many, so the hot
 *  reconcile path passes 2 to stop at the first ambiguity). Precomputes per-line
 *  trimmed text + indent width once and pre-filters on the anchor line, so it's
 *  ~O(N) on the common case instead of re-dedenting every window (which stalled
 *  the synchronous tool_call hook multiple seconds on large files). */
function findDedentWindows(fileLines: string[], oldRel: string[], maxHits = Infinity): number[] {
	const len = oldRel.length;
	const hits: number[] = [];
	const n = fileLines.length;
	if (len === 0 || len > n) return hits;

	// Per-line precompute: trailing-trimmed text + leading-indent width (Infinity
	// marks a blank line so it's excluded from a window's min-indent baseline).
	const trimmed: string[] = new Array(n);
	const indentW: number[] = new Array(n);
	for (let i = 0; i < n; i++) {
		const t = fileLines[i].replace(/[ \t]+$/, "");
		trimmed[i] = t;
		indentW[i] = t.length === 0 ? Infinity : leadWs(t).length;
	}

	// Cheap necessary-condition pre-filter: the first non-blank oldRel line equals
	// some window line's trimmed content minus its (window) base, so that line must
	// end with the anchor string. Skips the full compare for nearly all positions.
	let anchorOff = -1;
	for (let k = 0; k < len; k++) {
		if (oldRel[k] !== "") {
			anchorOff = k;
			break;
		}
	}
	const anchorStr = anchorOff >= 0 ? oldRel[anchorOff] : "";

	for (let i = 0; i + len <= n; i++) {
		if (anchorOff >= 0) {
			const a = trimmed[i + anchorOff];
			if (a.length === 0 || !a.endsWith(anchorStr)) continue;
		}
		let base = Infinity;
		for (let k = 0; k < len; k++) {
			const w = indentW[i + k];
			if (w < base) base = w;
		}
		if (!isFinite(base)) continue; // all-blank window
		let eq = true;
		for (let k = 0; k < len; k++) {
			const t = trimmed[i + k];
			const rel = t.length === 0 ? "" : t.slice(base);
			if (rel !== oldRel[k]) {
				eq = false;
				break;
			}
		}
		if (eq) {
			hits.push(i);
			if (hits.length >= maxHits) return hits;
		}
	}
	return hits;
}

/** Apply a uniform indentation shift to every non-blank line. shift<0 removes
 *  |shift| leading whitespace chars; shift>0 prepends `shift` indent chars taken
 *  from the file block. `textChar` is the indent character of the text BEING
 *  shifted (newText): the guard runs on BOTH directions — a removal that ate the
 *  wrong character class, or a padding that mixed tabs+spaces, would silently
 *  corrupt indentation in a whitespace-significant language, so bail instead.
 *  "none" = the text has no internal indent, compatible with either file char. */
function shiftIndent(
	text: string,
	shift: number,
	fileChar: DedentInfo["char"],
	textChar: DedentInfo["char"],
): string | null {
	if (textChar === "mixed") return null;
	if (shift === 0) return text;
	// Char-class compatibility (only meaningful when both sides carry indent):
	// a tab/space mismatch would emit mixed indentation, so bail.
	if (textChar !== "none" && fileChar !== "none" && textChar !== fileChar) return null;
	const lines = text.split("\n");
	if (shift < 0) {
		const drop = -shift;
		return lines
			.map((line) => (isBlank(line) ? line : line.slice(Math.min(drop, leadWs(line).length))))
			.join("\n");
	}
	// shift>0 ⇒ fileChar carries indent (base>0 ⇒ not "none"; "mixed" bailed upstream).
	const ch = fileChar === "tab" ? "\t" : " ";
	const pad = ch.repeat(shift);
	return lines.map((line) => (isBlank(line) ? line : pad + line)).join("\n");
}

/** Reconcile a single edit against the file. Returns the rewritten edit, or null
 *  to leave it untouched (exact already matches, no unique dedent match, or an
 *  ambiguous/unsafe indent situation). */
function reconcileOne(fileLF: string, edit: NormEdit): NormEdit | null {
	const oldLF = toLF(edit.oldText);
	if (!oldLF) return null;
	if (fileLF.includes(oldLF)) return null; // exact (or duplicate) — Pi handles it

	const fileLines = fileLF.split("\n");
	let oldLines = oldLF.split("\n");

	// A trailing newline in oldText yields a final "" element that only matches if
	// the file has a blank line there. Drop it for matching; re-add the newline
	// when reconstructing oldText (so it stays an exact file substring).
	let trailingNL = false;
	if (oldLines.length > 1 && oldLines[oldLines.length - 1] === "") {
		oldLines = oldLines.slice(0, -1);
		trailingNL = true;
	}

	const oldD = dedentForCompare(oldLines);
	if (!oldD || oldD.char === "mixed") return null;

	const hits = findDedentWindows(fileLines, oldD.rel, 2); // stop at first ambiguity
	if (hits.length !== 1) return null; // 0 or ambiguous → bail (Fix A enriches)

	const start = hits[0];
	const len = oldLines.length;
	const win = fileLines.slice(start, start + len);
	const fileD = dedentForCompare(win);
	if (!fileD || fileD.char === "mixed") return null;

	const hasFollowing = start + len < fileLines.length;
	let newOldText = win.join("\n");
	if (trailingNL && hasFollowing) newOldText += "\n";

	// Re-anchor newText by ITS OWN base, not oldText's. The replacement must land
	// at the file block's indentation (fileD.base) regardless of what indent the
	// model authored newText at — a model that mis-indents oldText may well author
	// newText at a different (even already-correct) base, and shifting it by
	// oldText's delta would then corrupt it (pushing lines out of scope). Shifting
	// newText to fileD.base from its own base preserves its internal structure and
	// degenerates to the old behavior whenever oldD.base === newD.base.
	const newLF = toLF(edit.newText);
	const newD = dedentForCompare(newLF.split("\n"));
	const newBase = newD ? newD.base : fileD.base; // all-blank newText → no shift
	const newChar = newD ? newD.char : "none";
	const adjustedNew = shiftIndent(newLF, fileD.base - newBase, fileD.char, newChar);
	if (adjustedNew === null) return null;

	if (newOldText === adjustedNew) return null; // degenerate replace-X-with-X
	return { oldText: newOldText, newText: adjustedNew };
}

/** Locate the edits[] entries on a tool input, handling the array form, the
 *  JSON-string form (some models), and the legacy single oldText/newText form.
 *  `commit` writes a reconciled array back into the same shape. */
function extractEdits(input: any): { edits: any[] | null; commit: (e: any[]) => void } {
	if (Array.isArray(input.edits)) {
		return { edits: input.edits, commit: (e) => void (input.edits = e) };
	}
	if (typeof input.edits === "string") {
		try {
			const parsed = JSON.parse(input.edits);
			if (Array.isArray(parsed)) return { edits: parsed, commit: (e) => void (input.edits = e) };
		} catch {
			/* not JSON */
		}
	}
	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		return {
			edits: [{ oldText: input.oldText, newText: input.newText }],
			commit: (e) => {
				if (e[0]) {
					input.oldText = e[0].oldText;
					input.newText = e[0].newText;
				}
			},
		};
	}
	return { edits: null, commit: () => {} };
}

function editPath(input: any): string | undefined {
	if (typeof input?.path === "string") return input.path;
	if (typeof input?.file_path === "string") return input.file_path;
	return undefined;
}

function readFileLF(path: string, cwd: string | undefined): string | null {
	try {
		return toLF(stripBom(readFileSync(resolveCwd(path, cwd), "utf-8")));
	} catch {
		return null;
	}
}

/** Fix B — mutate `input.edits` in place so a structurally-shifted oldText
 *  matches exactly. Returns true if anything was rewritten (for logging). Safe to
 *  call on any edit input; a no-match leaves the input untouched. */
export function reconcileEditInput(input: any, cwd: string | undefined): boolean {
	if (!input || typeof input !== "object") return false;
	const path = editPath(input);
	if (!path) return false;
	const fileLF = readFileLF(path, cwd);
	if (fileLF === null) return false;

	const { edits, commit } = extractEdits(input);
	if (!edits || edits.length === 0) return false;

	let changed = false;
	const out = edits.map((e) => {
		if (typeof e?.oldText !== "string" || typeof e?.newText !== "string") return e;
		const fixed = reconcileOne(fileLF, { oldText: e.oldText, newText: e.newText });
		if (!fixed) return e;
		changed = true;
		return { ...e, oldText: fixed.oldText, newText: fixed.newText };
	});
	if (changed) commit(out);
	return changed;
}

/** Character-bigram set for a string (for Dice similarity). */
function bigrams(s: string): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
	return out;
}

/** Sørensen–Dice similarity of two strings over character bigrams (0..1). */
function diceSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return 0;
	const ba = bigrams(a);
	const bb = bigrams(b);
	let inter = 0;
	for (const g of ba) if (bb.has(g)) inter++;
	return (2 * inter) / (ba.size + bb.size);
}

/** Index of the file line whose trimmed content is most similar to `anchor`,
 *  if above the threshold. Used to point a content-mismatch failure (typo,
 *  stale text) at the line the model most likely meant. */
function closestLine(fileLines: string[], anchor: string, threshold = 0.5): number {
	let best = -1;
	let bestScore = threshold;
	for (let i = 0; i < fileLines.length; i++) {
		const score = diceSimilarity(fileLines[i].trim(), anchor);
		if (score > bestScore) {
			bestScore = score;
			best = i;
		}
	}
	return best;
}

/** Render a line with leading + trailing whitespace made visible (interior
 *  spaces left readable). */
function visualizeWs(line: string): string {
	const lead = leadWs(line);
	const afterLead = line.slice(lead.length);
	const trailM = /[ \t]*$/.exec(afterLead);
	const trail = trailM ? trailM[0] : "";
	const mid = trail ? afterLead.slice(0, afterLead.length - trail.length) : afterLead;
	const vis = (s: string) => s.replace(/\t/g, VIS_TAB).replace(/ /g, VIS_SPACE);
	return vis(lead) + mid + vis(trail);
}

/** Fix A — on a "could not find" edit failure, build a hint showing the model's
 *  oldText and the closest file region with whitespace visualized. Returns null
 *  when there's nothing useful to add (so the caller leaves the result as-is). */
export function buildEditFailureHint(
	input: any,
	errorText: string,
	cwd: string | undefined,
): string | null {
	if (!input || typeof input !== "object") return null;
	if (!/could not find/i.test(errorText)) return null; // duplicate/overlap/empty are self-explanatory

	const path = editPath(input);
	if (!path) return null;
	const fileLF = readFileLF(path, cwd);
	if (fileLF === null) return null;

	const { edits } = extractEdits(input);
	if (!edits || edits.length === 0) return null;

	// Multi-edit errors name edits[i]; single-edit failures default to index 0.
	const m = /edits\[(\d+)\]/.exec(errorText);
	const idx = m ? Number(m[1]) : 0;
	const edit = edits[idx] ?? edits[0];
	if (!edit || typeof edit.oldText !== "string") return null;

	const oldLines = toLF(edit.oldText).split("\n");
	const fileLines = fileLF.split("\n");
	const oldD = dedentForCompare(oldLines);

	const parts: string[] = [];
	parts.push(
		`[edit hint] oldText not found in ${path}. Whitespace shown as ${VIS_SPACE}=space ${VIS_TAB}=tab — ` +
			`match the file's EXACT indentation.`,
	);
	parts.push("\nYour oldText (as sent):");
	parts.push(oldLines.map((l) => "  " + visualizeWs(l)).join("\n"));

	// Candidate locations: dedent match first; fall back to anchoring on the first
	// non-blank line's trimmed content.
	let candidates = oldD ? findDedentWindows(fileLines, oldD.rel, 6) : [];
	const anchor = (oldLines.find((l) => l.trim().length > 0) ?? "").trim();
	if (candidates.length === 0 && anchor) {
		// Exact trimmed-line anchors first (indentation-only mismatch).
		for (let i = 0; i < fileLines.length && candidates.length < 5; i++) {
			if (fileLines[i].trim() === anchor) candidates.push(i);
		}
		// Then the single closest line by similarity (content mismatch: typo/stale).
		if (candidates.length === 0) {
			const near = closestLine(fileLines, anchor);
			if (near >= 0) candidates.push(near);
		}
	}

	if (candidates.length === 0) {
		parts.push("\nNo similar region found — re-read the file to get its current exact text.");
		return parts.join("\n");
	}
	if (candidates.length > 1) {
		const lineNums = candidates.map((i) => i + 1).join(", ");
		parts.push(
			`\n${candidates.length} candidate locations (lines ${lineNums}). Add more surrounding context to make oldText unique.`,
		);
	}

	const start = candidates[0];
	const len = Math.max(1, oldLines.length);
	const ctx = 2;
	const from = Math.max(0, start - ctx);
	const to = Math.min(fileLines.length, start + len + ctx);
	const width = String(to).length;
	const region: string[] = [];
	for (let i = from; i < to; i++) {
		const num = String(i + 1).padStart(width, " ");
		const marker = i >= start && i < start + len ? ">" : " ";
		region.push(`${marker}${num} ${visualizeWs(fileLines[i])}`);
	}
	parts.push(`\nFile's actual text near line ${start + 1}:`);
	parts.push(region.join("\n"));
	return parts.join("\n");
}
