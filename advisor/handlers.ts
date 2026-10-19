/**
 * handlers — mid-session lifecycle handlers. A shared reconcileAdvisorTool
 * strips or re-adds the advisor tool to match the blocked state (with an
 * optional notify), and the three register*Handler functions wire it to
 * before_agent_start, model_select, and thinking_level_select.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { modelKey } from "@juicesharp/rpiv-config";
import { isLabModeActive } from "./lab-mode.js";
import {
	ADVISOR_TOOL_NAME,
	MSG_ADVISOR_DISABLED,
	MSG_ADVISOR_LAB_BLOCKED,
	msgAdvisorRestored,
} from "./messages.js";
import { isExecutorBlocked, isModelBlocked } from "./policy.js";
import {
	detectOptInRequest,
	isSessionOptedIn,
	recordSessionOptIn,
} from "./session-optin.js";
import { getAdvisorEffort, getAdvisorModel } from "./state.js";

/** Status-bar key for the persistent "advisor is on" indicator. */
export const ADVISOR_STATUS_KEY = "rpiv-advisor";

/**
 * Refresh the persistent status-bar indicator for the given session.
 *
 * The grant is per session, so the indicator must be re-evaluated on every
 * session_start / grant / revoke rather than set once at load: a session switch
 * in the same TUI must flip it back off. `undefined` clears the entry.
 *
 * Lab mode gets its own text: "off" alone would read as "you have not asked for
 * it yet", when the real reason is that it is not permitted at all here.
 */
export function refreshAdvisorStatus(ctx: ExtensionContext, sessionId: string | undefined): void {
	if (!ctx?.hasUI) return;
	if (isLabModeActive()) {
		ctx.ui.setStatus(ADVISOR_STATUS_KEY, "advisor: off (lab mode)");
		return;
	}
	const on = isSessionOptedIn(sessionId);
	ctx.ui.setStatus(ADVISOR_STATUS_KEY, on ? "advisor: on" : undefined);
}

interface ReconcileNotify {
	/** Shown when the tool is stripped (executor became blocked). */
	disabled: string;
	/** Shown when the tool is re-added (executor became unblocked). */
	restored: string;
}

// Strip-or-add the advisor tool to match the blocked state, with an optional
// notify on each transition. Reads the active-tool list itself. Shared by the
// three lifecycle handlers and the /advisor command's activate step.
export function reconcileAdvisorTool(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	opts: { blocked: boolean; notify?: ReconcileNotify; sessionId?: string },
): void {
	// The per-session opt-in is orthogonal to every existing block reason and is
	// ANDed in here so all callers inherit it: a session the user has not
	// explicitly enabled never gets the tool, whatever else is true. Lab mode is
	// ANDed in on the same line because it is an absolute prohibition — it must
	// win over a grant the session already holds.
	const sessionId = opts.sessionId ?? ctx?.sessionManager?.getSessionId?.();
	const blocked = opts.blocked || !isSessionOptedIn(sessionId) || isLabModeActive();
	const active = pi.getActiveTools();
	const hasTool = active.includes(ADVISOR_TOOL_NAME);
	if (blocked && hasTool) {
		pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
		if (opts.notify && ctx.hasUI) ctx.ui.notify(opts.notify.disabled, "info");
	} else if (!blocked && !hasTool) {
		pi.setActiveTools([...active, ADVISOR_TOOL_NAME]);
		if (opts.notify && ctx.hasUI) ctx.ui.notify(opts.notify.restored, "info");
	}
}

export function registerAdvisorBeforeAgentStart(pi: ExtensionAPI): void {
	pi.on("before_agent_start", async (_event, ctx) => {
		const sessionId = ctx?.sessionManager?.getSessionId?.();

		// Lab mode only suspends: the grant is NOT touched, so leaving lab restores
		// the previous state automatically. The strip itself happens in
		// reconcileAdvisorTool below, which ANDs `isLabModeActive()` into blocked.

		// No model → blocked (strip); model present → defer to the executor
		// blocklist. Routes through the reconcile hub so all strip/add logic
		// lives in one place rather than re-inlining the filter here.
		const blocked = !getAdvisorModel() || isExecutorBlocked(ctx, pi.getThinkingLevel());
		reconcileAdvisorTool(pi, ctx, { blocked });
		refreshAdvisorStatus(ctx, sessionId);
	});
}

export function registerModelSelectHandler(pi: ExtensionAPI): void {
	pi.on("model_select", async (event, ctx) => {
		// session_start restore path is owned by restoreAdvisorState — it already
		// activates the tool and notifies. Skipping "restore" here prevents a
		// duplicate notification on initial model load.
		if (event.source === "restore") return;

		const advisor = getAdvisorModel();
		if (!advisor) return;

		reconcileAdvisorTool(pi, ctx, {
			blocked: isModelBlocked(event.model, pi.getThinkingLevel()),
			notify: {
				disabled: `Advisor disabled for ${modelKey(event.model)}`,
				restored: msgAdvisorRestored(modelKey(advisor), getAdvisorEffort()),
			},
		});
	});
}

export function registerThinkingLevelSelectHandler(pi: ExtensionAPI): void {
	pi.on("thinking_level_select", async (event, ctx) => {
		const advisor = getAdvisorModel();
		if (!advisor) return;

		// `blocked === true` implies a defined model (isModelBlocked returns false
		// for undefined), so the MSG_ADVISOR_DISABLED fallback is unreachable — it
		// only keeps the disabled string total without a non-null assertion on the model.
		const model = ctx?.model;
		reconcileAdvisorTool(pi, ctx, {
			blocked: isModelBlocked(model, event.level),
			notify: {
				disabled: model ? `Advisor disabled for ${modelKey(model)}` : MSG_ADVISOR_DISABLED,
				restored: msgAdvisorRestored(modelKey(advisor), getAdvisorEffort()),
			},
		});
	});
}

/**
 * `input` hook — the per-session opt-in gate.
 *
 * Runs before `before_agent_start`, so granting here makes the tool available to
 * the very turn that asked for it rather than the next one. Returns
 * `{ action: "continue" }` unconditionally: the user's text is never rewritten,
 * because `transform` here would collide with any other extension's input
 * handler and leave a mutated prompt in the transcript.
 *
 * `source === "extension"` is skipped so programmatic input (workflow stages,
 * another extension injecting a prompt) cannot self-grant.
 */
export function registerInputOptInHandler(pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };

		const sessionId = ctx?.sessionManager?.getSessionId?.();
		const verdict = detectOptInRequest(event.text);
		if (!verdict.matched) return { action: "continue" };

		// Lab mode is an absolute prohibition, so the request is refused here
		// rather than granted-then-stripped: a silent strip would look like the
		// keyword failed to match, and the user would just repeat it.
		if (isLabModeActive()) {
			if (ctx?.hasUI) ctx.ui.notify(MSG_ADVISOR_LAB_BLOCKED, "warning");
			refreshAdvisorStatus(ctx, sessionId);
			return { action: "continue" };
		}
		if (isSessionOptedIn(sessionId)) return { action: "continue" };

		// Persisted into the session so a reload cannot lose it.
		recordSessionOptIn(pi, sessionId, true);

		// A grant with no usable advisor model cannot activate anything —
		// restore.ts owns the "no model" messaging, so only reconcile when a
		// model is actually selected. Reading it without the guard also made
		// `modelKey(model)` a non-null assertion over a real undefined case.
		const advisor = getAdvisorModel();
		if (advisor) {
			reconcileAdvisorTool(pi, ctx, {
				blocked: false,
				sessionId,
				notify: {
					disabled: MSG_ADVISOR_DISABLED,
					restored: msgAdvisorRestored(modelKey(advisor), getAdvisorEffort()),
				},
			});
		}
		refreshAdvisorStatus(ctx, sessionId);
		return { action: "continue" };
	});
}
