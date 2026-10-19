/**
 * command — the /advisor slash command. Reads top-down: interactive guard →
 * model picker (buildModelItems) → no-advisor branch (applyDisable) → model
 * lookup → effort picker (buildEffortItems) → enable (applyEnable). The apply
 * helpers persist before mutating in-memory state — a save failure must never
 * leave memory ahead of disk.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";
import { modelKey } from "@juicesharp/rpiv-config";
import { showAdvisorPicker, showEffortPicker } from "../advisor-ui.js";
import { saveAdvisorConfig, saveAdvisorDefaultEnabled } from "./config.js";
import { reconcileAdvisorTool, refreshAdvisorStatus } from "./handlers.js";
import {
	ADVISOR_TOOL_NAME,
	CHECKMARK,
	DEFAULT_EFFORT,
	EFFORT_ORDINAL,
	errSelectionNotFound,
	type GradedEffort,
	MSG_ADVISOR_DISABLED,
	MSG_ADVISOR_LAB_BLOCKED,
	MSG_ADVISOR_ALWAYS_OFF,
	MSG_ADVISOR_ALWAYS_PERSIST_FAILED,
	MSG_ADVISOR_NO_MODEL_CONFIGURED,
	MSG_EFFORT_NOT_SET,
	MSG_PERSIST_FAILED,
	MSG_REQUIRES_INTERACTIVE,
	msgAdvisorEnabled,
	msgAdvisorEnabledInactive,
	msgAdvisorAlwaysOn,
	msgAdvisorOnInactive,
	msgAdvisorSessionOff,
	NO_ADVISOR_VALUE,
	OFF_VALUE,
	RECOMMENDED_EFFORT_SUFFIX,
} from "./messages.js";
import { isLabModeActive } from "./lab-mode.js";
import { isExecutorBlocked } from "./policy.js";
import { recordSessionOptIn, resetSessionOptIn } from "./session-optin.js";
import { getAdvisorEffort, getAdvisorModel, setAdvisorEffort, setAdvisorModel } from "./state.js";

// Mirror: packages/rpiv-pi/extensions/rpiv-core/rpiv-models/items.ts
// buildModelItems — structural twin kept in a separate package by the
// zero-cross-imports contract; evolve model-picker semantics together.
function buildModelItems(availableModels: Model<Api>[], currentKey: string | undefined): SelectItem[] {
	const items: SelectItem[] = availableModels.map((m) => {
		const key = modelKey(m);
		const check = key === currentKey ? CHECKMARK : "";
		return { value: key, label: `${m.name}  (${m.provider})${check}` };
	});
	items.push({
		value: NO_ADVISOR_VALUE,
		label: currentKey === undefined ? `No advisor${CHECKMARK}` : "No advisor",
	});
	return items;
}

// Mirror: packages/rpiv-pi/extensions/rpiv-core/rpiv-models/items.ts
// buildEffortItems — same filter-in/map-out shape, different sentinels and
// persist target; evolve level-picker semantics together.
function buildEffortItems(picked: Model<Api>): SelectItem[] {
	// Intersect with EFFORT_ORDINAL (which excludes "off") so the picker can
	// never offer — hence saveAdvisorConfig can never persist — a level that
	// minEffort blocklist comparisons don't rank.
	const levels = getSupportedThinkingLevels(picked).filter((level): level is GradedEffort =>
		EFFORT_ORDINAL.includes(level as GradedEffort),
	);
	return [
		// "off (no reasoning sent)" ≠ /rpiv-models' "off (disable reasoning)":
		// this row sends NO reasoning option; /rpiv-models persists thinking:"off".
		{ value: OFF_VALUE, label: "off (no reasoning sent)" },
		...levels.map((level) => ({
			value: level,
			label: level === DEFAULT_EFFORT ? `${level}${RECOMMENDED_EFFORT_SUFFIX}` : level,
		})),
	];
}

// Disable path — persist BEFORE mutating in-memory state so a save failure
// can't strand "model=undefined + tool still registered". The strip
// is unconditional-on-presence (no advisor at all), so it stays inline rather
// than routing through reconcileAdvisorTool's blocked-conditional path.
function applyDisable(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!saveAdvisorConfig(undefined, undefined)) {
		ctx.ui.notify(MSG_PERSIST_FAILED, "error");
		return;
	}
	setAdvisorModel(undefined);
	setAdvisorEffort(undefined);
	// "No advisor" is an explicit revoke: drop this session's opt-in grant too,
	// otherwise the next before_agent_start would re-add a tool with no model.
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	// Recorded, not just cleared: a reload rebuilds from these entries, so a
	// memory-only revoke would come back on the next reload.
	recordSessionOptIn(pi, sessionId, false);
	const active = pi.getActiveTools();
	if (active.includes(ADVISOR_TOOL_NAME)) {
		pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
	}
	refreshAdvisorStatus(ctx, sessionId);
	ctx.ui.notify(MSG_ADVISOR_DISABLED, "info");
}

// Enable path — persist first, set in-memory state, activate via
// reconcileAdvisorTool (which re-reads the active-tool list post-effort-picker-
// await), and notify. Silent reconcile — the enable/inactive notify is the
// single trailing notify call here.
function applyEnable(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	picked: Model<Api>,
	effort: GradedEffort | undefined,
): void {
	if (!saveAdvisorConfig(modelKey(picked), effort)) {
		ctx.ui.notify(MSG_PERSIST_FAILED, "error");
		return;
	}
	setAdvisorEffort(effort);
	setAdvisorModel(picked);

	const sessionId = ctx?.sessionManager?.getSessionId?.();

	// Lab mode refuses the advisor outright. Saving the selection is harmless
	// (the config is shared with non-lab sessions), but granting here would be
	// a lie: reconcile strips the tool anyway, so refuse visibly instead.
	if (isLabModeActive()) {
		ctx.ui.notify(MSG_ADVISOR_LAB_BLOCKED, "warning");
		refreshAdvisorStatus(ctx, sessionId);
		return;
	}

	// Running /advisor is itself an explicit request for the advisor, so it
	// grants the current session (parity with typing "调用 advisor"). Without
	// this the picker would save a model that still cannot be used until a
	// keyword appears in some later turn.
	recordSessionOptIn(pi, sessionId, true);

	const blocked = isExecutorBlocked(ctx, pi.getThinkingLevel());
	reconcileAdvisorTool(pi, ctx, { blocked, sessionId });
	refreshAdvisorStatus(ctx, sessionId);
	ctx.ui.notify(
		blocked ? msgAdvisorEnabledInactive(modelKey(picked), effort) : msgAdvisorEnabled(modelKey(picked), effort),
		"info",
	);
}

/**
 * `/advisor always on|off` — the cross-session default.
 *
 * Scope is deliberately narrow: this changes what a session WITHOUT its own
 * record starts as. It does not touch the current session's record (the user
 * asked for a default, not a toggle), and it does not weaken the lab-mode
 * prohibition or the executor blocklist — both are still evaluated per turn.
 */
function applyAlways(pi: ExtensionAPI, ctx: ExtensionContext, enabled: boolean): void {
	if (!saveAdvisorDefaultEnabled(enabled)) {
		ctx.ui.notify(MSG_ADVISOR_ALWAYS_PERSIST_FAILED, "error");
		return;
	}
	if (enabled) {
		const model = getAdvisorModel();
		ctx.ui.notify(msgAdvisorAlwaysOn(model ? modelKey(model) : undefined), "info");
	} else {
		ctx.ui.notify(MSG_ADVISOR_ALWAYS_OFF, "info");
	}
}

/**
 * `/advisor off` — revoke this session's grant only.
 *
 * Deliberately NOT `applyDisable`: that path also clears the persisted model,
 * which is a different intent. "off" is the session-scoped counterpart of the
 * opt-in keyword; wiping the saved model would force a full re-pick next time
 * the user just wants the tool back.
 */
function applySessionOff(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	// Recorded, not just cleared: a reload rebuilds from these entries, so a
	// memory-only revoke would come back on the next reload.
	recordSessionOptIn(pi, sessionId, false);
	const active = pi.getActiveTools();
	if (active.includes(ADVISOR_TOOL_NAME)) {
		pi.setActiveTools(active.filter((n) => n !== ADVISOR_TOOL_NAME));
	}
	refreshAdvisorStatus(ctx, sessionId);
	const model = getAdvisorModel();
	ctx.ui.notify(msgAdvisorSessionOff(model ? modelKey(model) : undefined), "info");
}

/**
 * `/advisor on` — grant the current session without opening the model picker.
 *
 * Requires an already-configured model: granting with none would strip the tool
 * again on the very next turn (`!getAdvisorModel()` blocks), so the user would
 * see "enabled" and then nothing.
 */
function applySessionOn(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const model = getAdvisorModel();
	if (!model) {
		ctx.ui.notify(MSG_ADVISOR_NO_MODEL_CONFIGURED, "error");
		return;
	}
	if (isLabModeActive()) {
		ctx.ui.notify(MSG_ADVISOR_LAB_BLOCKED, "warning");
		return;
	}

	const sessionId = ctx?.sessionManager?.getSessionId?.();
	recordSessionOptIn(pi, sessionId, true);

	const blocked = isExecutorBlocked(ctx, pi.getThinkingLevel());
	reconcileAdvisorTool(pi, ctx, { blocked, sessionId });
	refreshAdvisorStatus(ctx, sessionId);
	ctx.ui.notify(
		blocked
			? msgAdvisorOnInactive(modelKey(model), getAdvisorEffort())
			: msgAdvisorEnabled(modelKey(model), getAdvisorEffort()),
		"info",
	);
}

export function registerAdvisorCommand(pi: ExtensionAPI): void {
	pi.registerCommand("advisor", {
		description: "Configure the advisor model; on/off toggle it for this session",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "on", label: "on", description: "Enable the advisor for this session" },
				{ value: "off", label: "off", description: "Disable the advisor for this session" },
				{ value: "always on", label: "always on", description: "New sessions start enabled (lab mode still overrides)" },
				{ value: "always off", label: "always off", description: "New sessions start disabled (default)" },
			];
			const p = prefix.trim().toLowerCase();
			return items.filter((i) => i.value.startsWith(p));
		},
		handler: async (args, ctx) => {
			// `on` / `off` are session-scoped toggles and must work without a
			// picker, so they are resolved BEFORE the interactive guard: they only
			// need notify/setStatus, which non-interactive hosts still accept.
			const sub = args.trim().toLowerCase().replace(/\s+/g, " ");
			if (sub === "on" || sub === "off") {
				if (sub === "on") applySessionOn(pi, ctx);
				else applySessionOff(pi, ctx);
				return;
			}
			if (sub === "always on" || sub === "always off") {
				applyAlways(pi, ctx, sub === "always on");
				return;
			}
			if (sub) {
				ctx.ui.notify(`Unknown /advisor argument: "${args.trim()}" (use on, off, always on, always off)`, "error");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(MSG_REQUIRES_INTERACTIVE, "error");
				return;
			}

			const availableModels = ctx.modelRegistry.getAvailable();
			const current = getAdvisorModel();
			const currentKey = current ? modelKey(current) : undefined;

			const choice = await showAdvisorPicker(ctx, buildModelItems(availableModels, currentKey));
			if (!choice) return;

			if (choice === NO_ADVISOR_VALUE) {
				applyDisable(pi, ctx);
				return;
			}

			const picked = availableModels.find((m) => modelKey(m) === choice);
			if (!picked) {
				ctx.ui.notify(errSelectionNotFound(choice), "error");
				return;
			}

			// Effort picker — only for reasoning-capable models
			let effortChoice: GradedEffort | undefined;
			if (picked.reasoning) {
				const effortResult = await showEffortPicker(
					ctx,
					buildEffortItems(picked),
					getAdvisorEffort(),
					DEFAULT_EFFORT,
				);
				if (!effortResult) {
					// Esc at the effort step keeps the model selection — cancelling
					// one step never discards prior choices (the invariant shared
					// with the /rpiv-models stepper). The divergence is deliberate:
					// that twin backs up without writing, while here the enable
					// proceeds and PERSISTS with no explicit effort (model default),
					// announced by this notify before the write.
					ctx.ui.notify(MSG_EFFORT_NOT_SET, "info");
				} else {
					effortChoice = effortResult === OFF_VALUE ? undefined : (effortResult as GradedEffort);
				}
			}

			applyEnable(pi, ctx, picked, effortChoice);
		},
	});
}
