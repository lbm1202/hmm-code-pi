// Plan file paths + allocation helper. Used by finalize_plan to write a new
// uniquely-named plan under PLANS_DIR.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PLANS_DIR = join(homedir(), ".pi", "agent", "plans");

const ADJECTIVES = [
	"curious", "jolly", "brave", "calm", "eager", "gentle", "happy", "kind",
	"lively", "merry", "nimble", "polite", "quiet", "swift", "tender", "vibrant",
	"witty", "zany", "bright", "cosy", "daring", "fancy", "glad", "humble",
	"keen", "loud", "mighty", "neat", "odd", "proud", "rapid", "silent",
	"sly", "stoic", "smug", "snug", "sage", "wild", "young", "zealous",
];
const NOUNS = [
	"kettle", "falcon", "mountain", "river", "forest", "cloud", "ember", "harbor",
	"lantern", "meadow", "ocean", "pebble", "quill", "ranger", "shadow", "tide",
	"vault", "willow", "beacon", "comet", "dawn", "echo", "frost", "glade",
	"hazel", "ivy", "juniper", "lake", "mist", "nova", "orchid", "petal",
	"quartz", "ridge", "spring", "thicket", "umber", "vista", "wren", "zenith",
];

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)] as T;
}

function dateStamp(): string {
	const d = new Date();
	return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** Allocate a unique plan-*.md path under PLANS_DIR. */
export function uniquePlanPath(): string {
	const date = dateStamp();
	for (let i = 0; i < 50; i++) {
		const file = `plan-${date}-${pick(ADJECTIVES)}-${pick(NOUNS)}.md`;
		const full = join(PLANS_DIR, file);
		if (!existsSync(full)) return full;
	}
	return join(PLANS_DIR, `plan-${date}-${Date.now()}.md`);
}
