/**
 * messages — advisor vocabulary: tool identity, selector sentinels, effort
 * levels, UI labels, and every user-facing string (static + parameterized).
 * Pure declarations, no logic; consumed across the advisor/ modules.
 */

import type { ThinkingLevel } from "@earendil-works/pi-ai";

// Tool identity
export const ADVISOR_TOOL_NAME = "advisor";
export const TOOL_LABEL = "Advisor";

// Selector sentinels — double-underscore form is collision-proof against real provider:id keys
export const NO_ADVISOR_VALUE = "__no_advisor__";
export const OFF_VALUE = "__off__";

// Effort levels. GradedEffort is the ordinal's domain: the graded levels only,
// never "off" — an "off" element would corrupt the indexOf ranking that
// minEffort thresholds compare against. Today pi-ai's ThinkingLevel already
// excludes "off" (the Exclude is a defensive no-op); the alias keeps that
// exclusion structural if the upstream universe ever re-widens.
export type GradedEffort = Exclude<ThinkingLevel, "off">;
export const EFFORT_ORDINAL: readonly GradedEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const DEFAULT_EFFORT: GradedEffort = "high";
export const RECOMMENDED_EFFORT_SUFFIX = "  (recommended)";

// UI — labels used by command flow; panel prose/titles live in advisor-ui.ts
export const CHECKMARK = " ✓";

// Messages (static)
export const MSG_ADVISOR_DISABLED = "Advisor disabled";
/** /advisor off — the session grant is gone, the configured model is untouched. */
export const msgAdvisorSessionOff = (label: string | undefined) =>
	label
		? `Advisor off for this session (model still configured: ${label}) — say "调用 advisor" or run /advisor on to re-enable`
		: "Advisor off for this session";
/** /advisor on without a configured model — cannot activate anything. */
export const MSG_ADVISOR_NO_MODEL_CONFIGURED =
	"Advisor has no model configured — run /advisor to pick one first";
/** /advisor always on|off — cross-session default. */
export const msgAdvisorAlwaysOn = (label: string | undefined) =>
	label
		? `Advisor default: ON — new sessions start enabled (${label}). Lab mode still overrides.`
		: "Advisor default: ON — new sessions start enabled. Lab mode still overrides.";
export const MSG_ADVISOR_ALWAYS_OFF =
	"Advisor default: OFF — new sessions start disabled; say \"调用 advisor\" or run /advisor on per session.";
export const MSG_ADVISOR_ALWAYS_PERSIST_FAILED =
	"Advisor default not saved — could not write advisor.json";
/** /advisor on — enabled, but the executor itself is on the blocklist. */
export const msgAdvisorOnInactive = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor enabled for this session: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
export const MSG_REQUIRES_INTERACTIVE = "/advisor requires interactive mode";
export const MSG_ADVISOR_NUDGE = "Please advise on the executor's situation above.";
export const MSG_EFFORT_NOT_SET = "Effort not set — advisor uses the model default";
export const MSG_PERSIST_FAILED = "Failed to save advisor selection — selection not persisted";

// Errors (static)
export const ERR_NO_MODEL = "No advisor model is configured. The user can enable one with the /advisor command.";
export const ERR_CALL_ABORTED = "Advisor call was cancelled before it completed.";
export const ERR_EMPTY_RESPONSE = "Advisor returned no text content.";
export const ERR_NO_MODEL_SELECTED = "no advisor model selected";
export const ERR_EMPTY_RESPONSE_DETAIL = "empty response";
export const ERR_ABORTED_DETAIL = "aborted";
export const ERR_UNKNOWN = "unknown error";

// Errors/messages (parameterized)
export const errMisconfigured = (label: string, err: string) => `Advisor (${label}) is misconfigured: ${err}`;
export const errNoApiKey = (label: string) => `Advisor (${label}) has no API key available.`;
export const errNoApiKeyDetail = (provider: string) => `no API key for ${provider}`;
export const errCallFailed = (err: string | undefined) => `Advisor call failed: ${err ?? ERR_UNKNOWN}`;
export const errCallThrew = (msg: string) => `Advisor call threw: ${msg}`;
export const errSelectionNotFound = (choice: string) => `Advisor selection not found: ${choice}`;
export const errModelUnavailable = (key: string) => `Previously configured advisor model ${key} is no longer available`;
export const msgAdvisorEnabled = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor: ${label}${effort ? `, ${effort}` : ""}`;
export const msgAdvisorRestored = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""}`;
export const msgAdvisorRestoredInactive = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor restored: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
/**
 * Lab environment refuses the advisor outright — not "not yet enabled", so it
 * gets its own wording. The advisor would ship the whole lab transcript to an
 * external model, which is exactly the boundary lab mode exists to keep.
 */
export const MSG_ADVISOR_LAB_BLOCKED =
	"Advisor 不参与 lab 环境：请先执行「退出实验」，再重新要求启用 advisor。";
/** Session starts with the advisor OFF; the model is configured but not usable until opted in. */
export const msgAdvisorReadyOptIn = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor configured: ${label}${effort ? `, ${effort}` : ""} — off by default; say "调用 advisor" to enable for this session`;
export const msgAdvisorEnabledInactive = (label: string, effort: ThinkingLevel | undefined) =>
	`Advisor: ${label}${effort ? `, ${effort}` : ""} (inactive for current executor)`;
export const msgConsulting = (label: string, effort: ThinkingLevel | undefined) =>
	`Consulting advisor (${label}${effort ? `, ${effort}` : ""})…`;
