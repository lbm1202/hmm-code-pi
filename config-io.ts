// File I/O for files this extension owns under ~/.pi/agent/:
//   modes.json          — user mode configuration (updated by /mode-set)
//   modes.example.json  — auto-written once as a template
//   keybindings.json    — overrides we need (free Shift+Tab etc.)
//   settings.json       — Pi flags we want by default (quietStartup)
// All writes are best-effort: parse failures leave files alone, write failures
// log to stderr but never throw.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MODE_NAMES, MODES_CONFIG_PATH, type ModeName } from "./config";

export const EXAMPLE_CONFIG = `{
  "defaultMode": "code",
  "modelAliases": {
    "openai-codex/gpt-5.5": "GPT 5.5",
    "anthropic/claude-sonnet-4.6": "Sonnet 4.6"
  },
  "modes": {
    "plan": {
      "model": "none",
      "thinkingLevel": "high",
      "activeTools": ["read", "grep", "find", "ls", "bash"],
      "temperature": 0.2
    },
    "code": {
      "model": "none",
      "thinkingLevel": "medium",
      "activeTools": ["read", "edit", "write", "bash", "grep", "find", "ls"],
      "temperature": 0.4
    },
    "debug": {
      "model": "none",
      "thinkingLevel": "high",
      "activeTools": ["read", "bash", "grep", "find", "ls"],
      "temperature": 0.3
    },
    "ask": {
      "model": "none",
      "thinkingLevel": "off",
      "activeTools": ["read", "grep"],
      "temperature": 0.5
    }
  },
  "autoTitle": {
    "provider": "openai",
    "id": "gpt-4.1-nano"
  },
  "modelAllowlist": {
    "openai-codex": ["gpt-5.5"]
  },
  "permissions": {
    "rules": {
      "read":  { "*.key": "ask", "*.pem": "ask" },
      "bash":  { "rm -rf /*": "deny", "sudo *": "ask" }
    },
    "external_directory": {
      "~/Downloads/**": "allow"
    },
    "modes": {
      "debug": {
        "rules": {
          "bash": { "pytest *": "allow", "npm test *": "allow" }
        }
      }
    }
  }
}
`;

// Modes wants Tab for mode cycle and Shift+Tab for Pi's autocomplete.
// Pi defaults: Tab → tui.input.tab (autocomplete), Shift+Tab → app.thinking.cycle.
// We swap: Tab is freed for our cycleMode shortcut (shortcuts.ts) by moving
// autocomplete to Shift+Tab, and we move thinking-cycle to Ctrl+Shift+T so it
// doesn't collide with the new Shift+Tab autocomplete binding.
const KEYBINDING_OVERRIDES: Record<string, string[]> = {
	"tui.input.tab": ["shift+tab"],
	"app.thinking.cycle": ["shift+ctrl+t"],
	"app.thinking.toggle": [],
	"app.tree.filter.noTools": [],
};
const KEYBINDING_OVERRIDES_TO_REMOVE: string[] = [];

const DESIRED_SETTINGS: Record<string, unknown> = {
	quietStartup: true,
	hideThinkingBlock: true,
};

function arraysEqual(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

export function ensureKeybindingsOverride(): { updated: boolean; path: string } {
	const path = join(homedir(), ".pi", "agent", "keybindings.json");
	let existing: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		} catch (err) {
			console.error(`[modes:config-io] Could not parse ${path}: ${err}. Leaving file alone.`);
			return { updated: false, path };
		}
	}

	let updated = false;
	for (const [action, keys] of Object.entries(KEYBINDING_OVERRIDES)) {
		const current = existing[action];
		if (!Array.isArray(current) || !arraysEqual(current as string[], keys)) {
			existing[action] = keys;
			updated = true;
		}
	}
	for (const action of KEYBINDING_OVERRIDES_TO_REMOVE) {
		if (action in existing) {
			delete existing[action];
			updated = true;
		}
	}

	if (updated) {
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
		} catch (err) {
			console.error(`[modes:config-io] Failed to write ${path}: ${err}`);
			return { updated: false, path };
		}
	}
	return { updated, path };
}

export function ensureQuietStartup(): { updated: boolean; path: string } {
	const path = join(homedir(), ".pi", "agent", "settings.json");
	let existing: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		} catch (err) {
			console.error(`[modes:config-io] Could not parse ${path}: ${err}. Leaving file alone.`);
			return { updated: false, path };
		}
	}
	let updated = false;
	for (const [key, value] of Object.entries(DESIRED_SETTINGS)) {
		if (existing[key] !== value) {
			existing[key] = value;
			updated = true;
		}
	}
	if (!updated) return { updated: false, path };
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
	} catch (err) {
		console.error(`[modes:config-io] Failed to write ${path}: ${err}`);
		return { updated: false, path };
	}
	return { updated: true, path };
}

/** Update a single field for one mode in modes.json, preserving mode order. */
export function updateModeConfigField(
	mode: ModeName,
	field: "model" | "thinkingLevel",
	value: unknown,
): { error?: string } {
	let existing: { defaultMode?: string; modes?: Record<string, any> } = {};
	if (existsSync(MODES_CONFIG_PATH)) {
		try {
			existing = JSON.parse(readFileSync(MODES_CONFIG_PATH, "utf-8"));
		} catch (err) {
			return { error: `parse failed: ${err}` };
		}
	}
	if (!existing.modes) existing.modes = {};
	if (!existing.modes[mode]) existing.modes[mode] = {};
	existing.modes[mode][field] = value;

	// Re-serialize in MODE_NAMES order; preserve any user-added extras at end.
	const ordered: Record<string, any> = {};
	for (const name of MODE_NAMES) {
		if (existing.modes[name] !== undefined) ordered[name] = existing.modes[name];
	}
	for (const key of Object.keys(existing.modes)) {
		if (!(key in ordered)) ordered[key] = existing.modes[key];
	}
	existing.modes = ordered;
	try {
		mkdirSync(dirname(MODES_CONFIG_PATH), { recursive: true });
		writeFileSync(MODES_CONFIG_PATH, `${JSON.stringify(existing, null, 2)}\n`, "utf-8");
		return {};
	} catch (err) {
		return { error: `${err}` };
	}
}

export function writeExampleConfigIfMissing(): void {
	const examplePath = join(homedir(), ".pi", "agent", "modes.example.json");
	try {
		if (existsSync(examplePath)) return;
		mkdirSync(dirname(examplePath), { recursive: true });
		writeFileSync(examplePath, EXAMPLE_CONFIG, "utf-8");
	} catch (err) {
		console.error(`[modes:config-io] Failed to write ${examplePath}: ${err}`);
	}
}
