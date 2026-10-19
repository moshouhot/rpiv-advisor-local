/**
 * restore — session_start restoration. Loads persisted config, re-applies the
 * model/effort selection + blocklist, activates the tool when not blocked, and
 * announces once per process. Wired via registerAdvisorSessionStart.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey, parseModelKey } from "@juicesharp/rpiv-config";
import { loadAdvisorConfig, validateDisabledForModels } from "./config.js";
import { reconcileAdvisorTool, refreshAdvisorStatus } from "./handlers.js";
import {
	ADVISOR_TOOL_NAME,
	EFFORT_ORDINAL,
	errModelUnavailable,
	MSG_ADVISOR_LAB_BLOCKED,
	msgAdvisorReadyOptIn,
	msgAdvisorRestored,
	msgAdvisorRestoredInactive,
} from "./messages.js";
import { isLabModeActive } from "./lab-mode.js";
import { isExecutorBlocked, setDisabledForModels } from "./policy.js";
import {
	optInSession,
	resetSessionOptIn,
	restoreSessionOptIn,
} from "./session-optin.js";
import { setAdvisorEffort, setAdvisorModel } from "./state.js";

/**
 * Module-local "already announced" latch. Pi fires `session_start` for every
 * session including programmatic spawns (workflow stages, batch ops, any
 * extension's `newSession` call). State mutation belongs on every fire;
 * the user-facing announcement does NOT — repeating it per stage in a
 * `/wf` run just spams the status line. The latch flips on the first
 * notify and stays set until the module is reloaded (`/reload`) or the
 * process restarts. Test-resettable via `__resetAdvisorAnnounced()`.
 */
let restoreAnnounced = false;

/** Test reset — wired into test/setup.ts `beforeEach`. */
export function __resetAdvisorAnnounced(): void {
	restoreAnnounced = false;
}

export function restoreAdvisorState(ctx: ExtensionContext, pi: ExtensionAPI): void {
	const sessionId = ctx?.sessionManager?.getSessionId?.();

	// A reload replaces the whole extension runtime, so the in-memory Set is
	// empty afterwards and this must REBUILD the grant rather than clear it.
	// Startup/new/resume/fork rebuild the same way: `restoreSessionOptIn` reads
	// the session's own entries, so a fresh session (no entries) still starts
	// closed and a reloaded one comes back exactly as it was.
	const config = loadAdvisorConfig();
	const recorded = restoreSessionOptIn(ctx?.sessionManager, sessionId);
	if (recorded === undefined) {
		// No per-session record: fall back to the configured default
		// (`/advisor always on|off`). Staying silent would make "always on"
		// indistinguishable from "never asked".
		resetSessionOptIn(sessionId);
		if (config.defaultEnabled) optInSession(sessionId);
	}

	// Lab mode SUSPENDS the advisor; it does not revoke the grant.
	//
	// Lab is already ANDed into `reconcileAdvisorTool`'s blocked computation, so
	// the tool stays stripped for as long as the flag is present and comes back
	// on its own once it is gone. Recording `{enabled:false}` here would be a
	// one-way door: the persistent record outranks the configured default, so
	// "always on" would never recover after leaving lab — which is exactly the
	// behaviour the user asked for.
	//
	// Only an explicit user action (/advisor off, /advisor always off) writes a
	// false record.

	// Refresh up front: the `deactivate` early-return paths below never reach the
	// reconcile that would otherwise set it, so a session switch (or a reload in
	// a host that keeps the status line) would show stale text.
	refreshAdvisorStatus(ctx, sessionId);


	setDisabledForModels(validateDisabledForModels(config.disabledForModels));

	// No usable advisor model → clear in-memory selection, then strip the tool
	// (and its prompt block) from the active set. Clearing state mirrors the
	// /advisor disable path (command.ts applyDisable): `selectedAdvisor` is
	// module-level and persists across session_start fires, so leaving it stale
	// would let the per-turn before_agent_start strip read a truthy model and
	// re-add the very tool we just stripped (e.g. a configured model removed
	// from the registry mid-process). The tool is registered active-by-default
	// at load, so its promptSnippet/promptGuidelines otherwise linger in the
	// base system prompt even though every advisor() call would fail with
	// ERR_NO_MODEL. See issue #72.
	const deactivate = (): void => {
		setAdvisorModel(undefined);
		setAdvisorEffort(undefined);
		reconcileAdvisorTool(pi, ctx, { blocked: true });
	};

	if (!config.modelKey) {
		deactivate();
		return;
	}

	const parsed = parseModelKey(config.modelKey);
	if (!parsed) {
		deactivate();
		return;
	}

	const notifyOnce = (msg: string, level: "info" | "warning" | "error"): void => {
		if (!ctx.hasUI || restoreAnnounced) return;
		ctx.ui.notify(msg, level);
		restoreAnnounced = true;
	};

	const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
	if (!model) {
		deactivate();
		notifyOnce(errModelUnavailable(config.modelKey), "warning");
		return;
	}

	setAdvisorModel(model);
	// Overwrite — never merge — the in-memory effort with the persisted value.
	// "Model present, effort absent" is a first-class persisted state (the
	// /advisor Esc and off choices both save it), and another process can
	// remove the field from the shared advisor.json mid-session; a guarded set
	// here would leave a stale module-level effort feeding `reasoning` on every
	// advisor call. A hand-edited value unknown to EFFORT_ORDINAL is dropped
	// with a warning rather than restored and sent as `reasoning`.
	let effort = config.effort;
	if (effort !== undefined && !EFFORT_ORDINAL.includes(effort)) {
		console.warn(
			`[rpiv-advisor] advisor.json: unknown effort "${effort}" — ignoring (valid values: ${EFFORT_ORDINAL.join(", ")})`,
		);
		effort = undefined;
	}
	setAdvisorEffort(effort);

	// Lab mode forbids the advisor, so the "say 调用 advisor to enable" hint would
	// be actively wrong here — say why it is unavailable instead.
	if (isLabModeActive()) {
		reconcileAdvisorTool(pi, ctx, { blocked: true, sessionId });
		refreshAdvisorStatus(ctx, sessionId);
		notifyOnce(MSG_ADVISOR_LAB_BLOCKED, "warning");
		return;
	}

	if (isExecutorBlocked(ctx, pi.getThinkingLevel())) {
		reconcileAdvisorTool(pi, ctx, { blocked: true });
		const advisorLabel = modelKey(model);
		notifyOnce(msgAdvisorRestoredInactive(advisorLabel, effort), "info");
		return;
	}

	// Route through the reconcile hub instead of adding the tool directly: it is
	// the single place that applies the per-session opt-in gate, so a bare
	// setActiveTools here would bypass the gate added for this feature.
	reconcileAdvisorTool(pi, ctx, { blocked: false, sessionId });
	refreshAdvisorStatus(ctx, sessionId);

	notifyOnce(msgAdvisorReadyOptIn(modelKey(model), effort), "info");
}

export function registerAdvisorSessionStart(pi: ExtensionAPI): void {
	pi.on("session_start", async (event, ctx) => {
		restoreAdvisorState(ctx, pi);
	});
}
