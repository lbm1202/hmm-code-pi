// Extension entry point. Boots the runtime context (ModeState + shared refs)
// and registers tools, commands, shortcuts, and event hooks. All the logic
// lives in the focused modules — this file is intentionally tiny so the boot
// shape is easy to follow.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUser } from "./ask-user";
import { registerAutoTitle } from "./auto-title";
import { registerCommands } from "./commands";
import { registerFinalizeImplementation } from "./finalize-implementation";
import { registerFinalizePlan } from "./finalize-plan";
import { registerHooks } from "./hooks";
import { registerPermissions } from "./permissions";
import { registerRequestModeSwitch } from "./request-mode-switch";
import { registerShortcuts } from "./shortcuts";
import { ModeState } from "./state";
import { registerTodo } from "./todo";
import { createRuntime } from "./runtime";

export default function modesExtension(pi: ExtensionAPI) {
	const state = new ModeState(pi);
	const rt = createRuntime(pi, state);

	pi.registerFlag("mode", {
		description: "Initial mode (plan | code | debug | ask | review)",
		type: "string",
	});

	// Tools
	registerAskUser(pi);
	registerRequestModeSwitch(pi, state);
	registerFinalizePlan(pi, state);
	registerFinalizeImplementation(pi, state);
	registerAutoTitle(pi, state);
	registerTodo(pi, state);

	// Slash commands / shortcuts / event hooks
	registerCommands(rt);
	registerShortcuts(rt);
	registerHooks(rt);
	registerPermissions(rt);
}
