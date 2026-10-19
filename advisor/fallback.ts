/**
 * fallback — account-level failover for the advisor side-call.
 *
 * LOCAL PATCH (not upstream). The advisor's `completeSimple` call bypasses Pi's
 * agent loop entirely, so it emits no `message_end` / `assistant_error` events.
 * Account-rotation extensions (e.g. pi-multi-account) therefore never observe an
 * advisor failure and never rotate accounts for it: one spent account takes the
 * advisor down while healthy siblings sit idle.
 *
 * This module supplies the two things that patch needs — a candidate list and a
 * refusal classifier — and nothing else. It deliberately owns no I/O and no
 * credential handling: credentials are resolved per candidate inside execute.ts,
 * because reusing one account's headers for every attempt would authenticate the
 * whole loop against the account that just refused.
 *
 * Scope boundary: "sibling" means the SAME model id on a DIFFERENT provider of
 * the same family. Different models are never candidates — the user configured a
 * specific reviewer, and silently downgrading it is exactly what must not happen.
 */

import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Collapse a numbered account slot to its family name:
 * `openai-codex-account-2` → `openai-codex`, `anthropic-account-3` → `anthropic`.
 *
 * Only the `-account-<N>` convention is recognised — the one the rotation
 * extensions publish. An arbitrary provider that happens to share a name prefix
 * is NOT treated as the same family, so two unrelated providers are never
 * cross-retried on a naming coincidence.
 */
export function advisorFamily(provider: string): string {
	return provider.replace(/-account-\d+$/, "");
}

/**
 * True when `provider` belongs to the same account family as `family`.
 *
 * Both directions matter: with the base configured, the numbered slots are its
 * siblings; with a numbered slot configured, the BASE is its sibling (that is
 * the failover case — the spent account is often the base). `advisorFamily`
 * only collapses the `-account-<N>` suffix, so an unrelated provider that merely
 * shares a name prefix cannot reduce to `family` and is never admitted here.
 */
export function isSiblingProvider(provider: string, family: string): boolean {
	return advisorFamily(provider) === family;
}

/** Numeric slot index for stable ordering; base provider and unparsable ids sort first. */
function slotIndex(provider: string): number {
	const match = provider.match(/-account-(\d+)$/);
	return match ? Number(match[1]) : 0;
}

/**
 * Build the ordered candidate list for one advisor call.
 *
 * The configured primary is ALWAYS first and is never displaced. Siblings are
 * same-model-id, same-family, other-provider entries sorted by slot index.
 *
 * Rationale for keeping the primary pinned at the head rather than ranking by
 * health: the user chose that reviewer, and a dynamic (last-success) order would
 * add cross-process state, cache lifetimes and credential-refresh races for a
 * latency win only. The cost of a pinned head is one refused request per call
 * while the primary is spent — bounded, visible, and honest.
 */
export function buildAdvisorCandidates(
	available: readonly Model<Api>[],
	primary: Model<Api>,
): Model<Api>[] {
	const family = advisorFamily(primary.provider);
	const siblings = available
		.filter(
			(model) =>
				model.id === primary.id &&
				model.provider !== primary.provider &&
				isSiblingProvider(model.provider, family),
		)
		.sort((a, b) => slotIndex(a.provider) - slotIndex(b.provider));

	// Dedupe by provider, preserving first occurrence (a registry may expose the
	// same provider twice through builtin + extension layers).
	const seen = new Set<string>([primary.provider]);
	const ordered: Model<Api>[] = [primary];
	for (const model of siblings) {
		if (seen.has(model.provider)) continue;
		seen.add(model.provider);
		ordered.push(model);
	}
	return ordered;
}

/**
 * Phrases that mean "this ACCOUNT is spent or unusable" — the only class another
 * account can actually fix.
 *
 * Deliberately narrow. Bare `insufficient`, `expired`, `capacity` and `billing`
 * are excluded because they also match non-account faults that switching cannot
 * help: `insufficient context capacity`, `expired request deadline`,
 * `service capacity`, `unsupported billing configuration`. Overload/503 and
 * generic capacity errors are SERVICE failures, not evidence a sibling helps.
 *
 * Every pattern is multi-word or credential-specific, so a bare number in a
 * request id cannot trip it.
 *
 * HTTP status codes (401/402/403/429) are rendered with `new RegExp` so the word
 * boundaries stay readable and cannot be mangled by escaping layers in tooling.
 */
const ACCOUNT_REFUSAL_STATUSES: readonly number[] = [401, 402, 403, 429];

const ACCOUNT_REFUSAL_PATTERNS: readonly RegExp[] = [
	...ACCOUNT_REFUSAL_STATUSES.map((code) => new RegExp(`\\b${code}\\b`)),
	/usage limit/i,
	/usage_limit_reached/i,
	/usage_not_included/i,
	/rate limit/i,
	/rate_limit/i,
	/too many requests/i,
	/quota/i,
	/insufficient_quota/i,
	/insufficient credits/i,
	/out of credits/i,
	/credit balance is too low/i,
	/out of budget/i,
	/available balance/i,
	/billing hard limit/i,
	/monthly usage limit/i,
	/payment required/i,
	/upgrade to a paid account/i,
	/add credits/i,
	/third-party apps now draw from your extra usage/i,
	/extra usage/i,
	/resource_exhausted/i,
	/you have hit your .*usage limit/i,
	/freeusagelimiterror/i,
	/gousagelimiterror/i,
	/limit_source/i,
	/remaining balance/i,
	/unauthorized/i,
	/authentication_error/i,
	/invalid api key/i,
	/incorrect api key/i,
	/no api key/i,
	/missing api key/i,
	/invalid_token/i,
	/invalid token/i,
	/token has been invalidated/i,
	/token has expired/i,
	/token expired/i,
	/expired token/i,
	/invalid_grant/i,
	/oauth token/i,
	/revoked/i,
	// Credential-shape faults: the provider accepted the request and then could not
	// derive an identity from the token. Account-specific, so a sibling helps.
	// Verified against Codex's real "Failed to extract accountId from token".
	/accountId from token/i,
	/extract accountId/i,
	/invalid account/i,
	/no such account/i,
];

/**
 * True when a failure is an account-level refusal worth trying a sibling for.
 *
 * Applied to BOTH returned `stopReason === "error"` messages and thrown
 * exceptions, so a thrown 429 advances while a thrown network timeout does not —
 * switching accounts cannot repair transport failure and would risk re-sending a
 * request whose response was merely lost.
 */
export function isRetryableAdvisorError(message: string | undefined): boolean {
	if (!message) return false;
	return ACCOUNT_REFUSAL_PATTERNS.some((pattern) => pattern.test(message));
}

/** One candidate's failure, retained so an exhausted chain can report why. */
export interface AdvisorAttemptFailure {
	/** `provider:modelId` of the candidate that failed. */
	label: string;
	/** Where it failed — keeps credential problems distinct from refusals. */
	stage: "credentials" | "call" | "threw";
	/** Sanitized reason. Never contains credentials or headers. */
	reason: string;
}

/**
 * Render the exhausted-chain error. Lists every attempt so the executor can tell
 * a genuine multi-account outage from a single misconfigured slot.
 */
export function errAllCandidatesFailed(failures: readonly AdvisorAttemptFailure[]): string {
	const detail = failures
		.map((failure) => `${failure.label} (${failure.stage}): ${failure.reason}`)
		.join("; ");
	return `Advisor call failed on every configured account. Attempts — ${detail}`;
}
