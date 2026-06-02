// Context-compaction policy: when to summarize, and how. Owns the auto-compact
// watchdog, the dynamic-vs-legacy decision, and the suppress-Pi's-built-in
// logic. hooks.ts wires the per-event triggers (turn_end = mid-loop round,
// agent_end = turn boundary) to `evalCompaction`; commands.ts/`/compact` drive
// `ctx.compact()` directly (flagged via state.compactRequestedByUs).

import { compact as runCompaction } from "@earendil-works/pi-coding-agent";
import { COMPACT_HARDCAP_MAX, DYNAMIC_COMPACT_GAP } from "./constants";
import type { Runtime } from "./runtime";

/** Current context-window usage percent, or undefined if unavailable. */
export function readPct(ctx: any): number | undefined {
	try {
		const pct = ctx?.getContextUsage?.()?.percent;
		return typeof pct === "number" ? pct : undefined;
	} catch (err) {
		console.error("[modes:compaction] getContextUsage failed:", err);
		return undefined;
	}
}

export interface Compaction {
	/** Run compaction policy for one event. `boundary` = the full user↔AI turn
	 *  just ended (agent_end); false = a mid-loop tool round (turn_end). */
	evalCompaction(ctx: any, boundary: boolean): void;
	/** Register the session_before_compact / session_compact hooks. */
	register(): void;
}

export function createCompaction(rt: Runtime): Compaction {
	const { pi, state } = rt;

	// Compact-in-flight tracking with a watchdog. Without it, if compact()
	// returns but neither onComplete nor session_compact ever fires (provider
	// error swallowed inside Pi, a queued no-op, etc.), the flag stays true
	// forever and the guards below silently disable auto-compact for the rest of
	// the session. 10 min: compaction summarizes the whole conversation with the
	// active model, so a large context on a reasoning model can legitimately take
	// minutes; the watchdog must outlast a slow-but-working compaction so it
	// doesn't re-arm and double-trigger a second compact mid-summary.
	const COMPACT_WATCHDOG_MS = 600_000;
	let compactWatchdog: any;
	const armCompact = (): void => {
		state.compactInFlight = true;
		if (compactWatchdog) clearTimeout(compactWatchdog);
		compactWatchdog = setTimeout(() => {
			compactWatchdog = undefined;
			if (state.compactInFlight) {
				console.error(
					"[modes:compaction] watchdog: no completion in 10 min — re-arming auto-compact",
				);
				state.compactInFlight = false;
			}
		}, COMPACT_WATCHDOG_MS);
		compactWatchdog?.unref?.();
	};
	const disarmCompact = (): void => {
		if (compactWatchdog) {
			clearTimeout(compactWatchdog);
			compactWatchdog = undefined;
		}
		state.compactInFlight = false;
	};

	// Mid-loop force-compact / Pi-built-in passthrough point: threshold + grace
	// band, capped so a little headroom stays below the real window (a genuine
	// overflow reads ~100% and must fall through to a compaction).
	const hardCap = (): number =>
		Math.min(state.autoCompactThreshold + DYNAMIC_COMPACT_GAP, COMPACT_HARDCAP_MAX);

	// Run OUR compaction. Sets compactRequestedByUs so session_before_compact
	// lets it through (vs Pi's built-in auto trigger, which we suppress).
	const triggerCompact = (ctx: any, pct: number): void => {
		if (state.compactInFlight) return;
		armCompact();
		state.compactRequestedByUs = true;
		ctx.ui.notify(
			`Auto-compacting at ${pct.toFixed(1)}% (threshold ${state.autoCompactThreshold}%)…`,
			"info",
		);
		try {
			ctx.compact?.({
				customInstructions: state.compactInstructionsOverride,
				onComplete: () => {
					disarmCompact();
					rt.invalidateFooter?.();
					rt.requestRender();
				},
				onError: (err: unknown) => {
					disarmCompact();
					state.compactRequestedByUs = false;
					ctx.ui.notify(`Auto-compact failed: ${err}`, "warning");
				},
			});
		} catch (err) {
			console.error("[modes:compaction] auto-compact call failed:", err);
			ctx.ui.notify(`Auto-compact failed: ${err}`, "warning");
			disarmCompact();
			state.compactRequestedByUs = false;
		}
	};

	// Compaction policy.
	//   dynamic on : compact only at the boundary, OR mid-loop past the hard cap.
	//   dynamic off: compact the moment usage crosses the threshold (legacy cut).
	const evalCompaction = (ctx: any, boundary: boolean): void => {
		if (state.compactInFlight) return;
		const pct = readPct(ctx);
		if (pct === undefined || pct < state.autoCompactThreshold) return;
		const trigger = state.dynamicCompaction ? boundary || pct >= hardCap() : true;
		if (trigger) triggerCompact(ctx, pct);
	};

	const register = (): void => {
		// All compaction funnels through here (our triggerCompact, the /compact
		// command, AND — in theory — Pi's built-in auto trigger). We own the policy
		// via turn_end/agent_end, so the host disables Pi's built-in via RPC
		// set_auto_compaction:false at spawn AND after every session switch (each
		// new/switched AgentSession re-defaults it to enabled) — see
		// chat-backend.ts:disableBuiltinAutoCompaction. This hook stays as a
		// fallback for the brief window before that disable lands (and for a genuine
		// context overflow, which Pi may still surface): if a non-ours compaction
		// sneaks in below the hard cap, cancel it; near overflow (or pct unknown)
		// let it through so a real overflow still recovers. When the trigger IS
		// ours, optionally swap in the dedicated model (modes.json:compactModel).
		pi.on("session_before_compact", async (event: any, ctx: any) => {
			// DEDUP (defense-in-depth). The root cause of duplicate handlers — this
			// hook being re-registered on every session_start — is fixed in
			// hooks.ts (setupRuntimeHooks runs once per process now). This guard
			// stays as cheap insurance: if our handler is ever wired more than once
			// again, a SINGLE compaction would fire all of them — the first reads
			// compactRequestedByUs=true and runs the compactModel summary (seconds),
			// then a duplicate sees the consumed flag (ours=false) and returns
			// {cancel}, aborting our own in-flight compaction ("Compaction
			// cancelled"). Keyed on the per-compaction AbortSignal: only the first
			// invocation for a given signal does the work; later duplicates no-op.
			// WeakSet on globalThis so it holds even across module re-evaluation.
			const g = globalThis as any;
			const seen: WeakSet<object> = (g.__hmmCompactSeen ??= new WeakSet());
			const sig = event?.signal;
			if (sig) {
				if (seen.has(sig)) return; // duplicate handler — first invocation owns it
				seen.add(sig);
			}
			const ours = state.compactRequestedByUs;
			state.compactRequestedByUs = false;
			if (!ours) {
				const pct = readPct(ctx);
				if (pct !== undefined && pct < hardCap()) {
					return { cancel: true };
				}
				// Near overflow (or pct unknown) → let Pi's compaction proceed.
				armCompact();
			}
			const ref = state.compactModelOverride;
			if (!ref?.provider || !ref?.id) return; // no override → Pi uses active model
			try {
				const model = ctx.modelRegistry?.find?.(ref.provider, ref.id);
				if (!model) return;
				const auth = await ctx.modelRegistry?.getApiKeyAndHeaders?.(model);
				if (!auth?.ok) return;
				const result = await runCompaction(
					event.preparation,
					model,
					auth.apiKey,
					auth.headers,
					event.customInstructions,
					event.signal,
					"off",
					undefined,
				);
				return { compaction: result };
			} catch (err) {
				// Fall back to Pi's default (active-model) compaction on any failure.
				console.error("[modes:compaction] compactModel summary failed — using active model:", err);
			}
		});
		pi.on("session_compact", async () => {
			disarmCompact();
			rt.invalidateFooter?.();
			rt.requestRender();
		});
	};

	return { evalCompaction, register };
}
