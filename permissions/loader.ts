// Disk loader for permission files. We read JSON on demand with mtime-keyed
// caching so the hook never blocks on disk I/O after the first call per file.
// Global (~/.pi/agent/permissions.json) and project (${cwd}/.pi/permissions.json)
// are loaded independently and returned in evaluation order.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Permissions } from "./types";

const GLOBAL_PATH = join(homedir(), ".pi", "agent", "permissions.json");
const GLOBAL_EXAMPLE_PATH = join(homedir(), ".pi", "agent", "permissions.example.json");

interface Cache {
	mtime: number;
	value: Permissions;
}
const cache = new Map<string, Cache>();

function readJsonCached(path: string): Permissions | undefined {
	if (!existsSync(path)) return undefined;
	let mtime: number;
	try {
		mtime = statSync(path).mtimeMs;
	} catch {
		return undefined;
	}
	const c = cache.get(path);
	if (c && c.mtime === mtime) return c.value;
	try {
		const raw = readFileSync(path, "utf-8");
		const parsed = JSON.parse(raw) as Permissions;
		cache.set(path, { mtime, value: parsed });
		return parsed;
	} catch (err) {
		console.error(`[modes:permissions] failed to parse ${path}:`, err);
		return undefined;
	}
}

export function loadGlobalPermissions(): Permissions | undefined {
	return readJsonCached(GLOBAL_PATH);
}

export function loadProjectPermissions(cwd: string | undefined): Permissions | undefined {
	if (!cwd) return undefined;
	return readJsonCached(join(cwd, ".pi", "permissions.json"));
}

const EXAMPLE_CONTENT = `// Pi modes extension — example permission overrides.
// Copy this file to permissions.json (drop the .example) to activate.
//
// Built-in defaults already cover .env / external dirs / safe bash commands
// (Kilo-aligned). Add only the rules you actually need below.
//
// Verdicts: "allow" | "ask" | "deny". Last matching rule wins per layer.
// Pattern syntax: gitignore-style globs (*, **, ?). ~/ = home dir.

{
  "rules": {
    "read":  {
      // "*.key": "ask",
      // "*.pem": "ask"
    },
    "bash": {
      // "rm -rf /*": "deny",
      // "sudo *":    "ask"
    }
  },
  "external_directory": {
    // "~/Downloads/**": "allow",
    // "/var/**":         "deny"
  },
  "modes": {
    "debug": {
      "rules": {
        "bash": {
          // "pytest *":   "allow",
          // "npm test *": "allow"
        }
      }
    }
  }
}
`;

/** Drop ~/.pi/agent/permissions.example.json on first run so the user has a
 *  ready-to-edit template. Idempotent — does nothing if the file is already
 *  there or the parent directory can't be created. */
export function writePermissionsExampleIfMissing(): void {
	try {
		if (existsSync(GLOBAL_EXAMPLE_PATH)) return;
		mkdirSync(dirname(GLOBAL_EXAMPLE_PATH), { recursive: true });
		writeFileSync(GLOBAL_EXAMPLE_PATH, EXAMPLE_CONTENT, "utf-8");
	} catch (err) {
		console.error("[modes:permissions] failed to write example file:", err);
	}
}
