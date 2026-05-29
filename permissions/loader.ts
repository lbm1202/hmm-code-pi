// Disk loader for permission files.
//
// As of the modes-config consolidation, the canonical home for global
// permissions is `~/.pi/agent/modes.json:permissions`. We still fall back
// to the legacy standalone `~/.pi/agent/permissions.json` so existing
// installs keep working, but new writes (from the VS Code settings panel)
// land in modes.json.
//
// Project-level permissions remain as `${cwd}/.pi/permissions.json` —
// projects don't have a per-project modes.json today, so keeping them
// separate is fine.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Permissions } from "./types";

const MODES_JSON_PATH = join(homedir(), ".pi", "agent", "modes.json");
const LEGACY_GLOBAL_PATH = join(homedir(), ".pi", "agent", "permissions.json");

interface Cache {
	mtime: number;
	value: Permissions | undefined;
}
const cache = new Map<string, Cache>();

function readJsonCached(path: string, pickKey?: string): Permissions | undefined {
	if (!existsSync(path)) return undefined;
	let mtime: number;
	try {
		mtime = statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
	const cacheKey = pickKey ? `${path}#${pickKey}` : path;
	const c = cache.get(cacheKey);
	if (c && c.mtime === mtime) return c.value;
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const value: Permissions | undefined = pickKey
			? (parsed[pickKey] as Permissions | undefined)
			: (parsed as Permissions);
		cache.set(cacheKey, { mtime, value });
		return value;
	} catch (err) {
		console.error(`[modes:permissions] failed to parse ${path}:`, err);
		return undefined;
	}
}

/** Global permissions: prefer modes.json:permissions, fall back to the
 *  legacy standalone permissions.json so existing setups keep working. */
export function loadGlobalPermissions(): Permissions | undefined {
	const fromModes = readJsonCached(MODES_JSON_PATH, "permissions");
	if (fromModes) return fromModes;
	return readJsonCached(LEGACY_GLOBAL_PATH);
}

export function loadProjectPermissions(cwd: string | undefined): Permissions | undefined {
	if (!cwd) return undefined;
	return readJsonCached(join(cwd, ".pi", "permissions.json"));
}

