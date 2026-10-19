/**
 * execute — the advisor side-call. Curates the executor's branch (inventory
 * prefix + tail massaging), invokes the advisor model via completeSimple with
 * no tools, and returns a structured tool result. Every result branch (success
 * / abort / error / empty) and the pre-call error paths funnel through
 * buildAdvisorResult so the envelope is built in exactly one place.
 */

import type { AssistantMessage, Message, StopReason, TextContent, ThinkingLevel, Usage } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ensureUserTailForAdvisor, stripInflightAdvisorCall, stripToolDeclarations } from "./context.js";
import {
	type AdvisorAttemptFailure,
	buildAdvisorCandidates,
	errAllCandidatesFailed,
	isRetryableAdvisorError,
} from "./fallback.js";
import { getInventoryMessage } from "./inventory.js";
import {
	ERR_ABORTED_DETAIL,
	ERR_CALL_ABORTED,
	ERR_EMPTY_RESPONSE,
	ERR_EMPTY_RESPONSE_DETAIL,
	ERR_NO_MODEL,
	ERR_NO_MODEL_SELECTED,
	ERR_UNKNOWN,
	errCallFailed,
	errCallThrew,
	errMisconfigured,
	errNoApiKeyDetail,
	msgConsulting,
} from "./messages.js";
import { getRuntimeCompleteSimple, loadCompleteSimple } from "./pi-compat.js";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.js";
import { getAdvisorEffort, getAdvisorModel } from "./state.js";

interface AdvisorDetails {
	advisorModel?: string;
	effort?: ThinkingLevel;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

// Extract the advisor's text content from a completeSimple response: concatenate
// every text part, trim. Thinking/toolCall parts are ignored. Returns "" when the
// model returned no text content — the empty-response class R6.4 retries once
// before surfacing. Pure so both attempts share one extraction path.
function advisorTextFromResponse(response: AssistantMessage): string {
	return response.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

// Single result-envelope builder — every executeAdvisor branch and the pre-call
// error paths funnel through here. `effort` is snapshotted once at executeAdvisor
// entry and threaded through every call so the returned details.effort always
// matches the value sent as `reasoning` to completeSimple, even if module-level
// state is mutated during the await window.
function buildAdvisorResult(opts: {
	text: string;
	effort: ThinkingLevel | undefined;
	advisorLabel?: string;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}): AgentToolResult<AdvisorDetails> {
	const details: AdvisorDetails = { effort: opts.effort };
	if (opts.advisorLabel !== undefined) details.advisorModel = opts.advisorLabel;
	if (opts.usage !== undefined) details.usage = opts.usage;
	if (opts.stopReason !== undefined) details.stopReason = opts.stopReason;
	if (opts.errorMessage !== undefined) details.errorMessage = opts.errorMessage;
	return { content: [{ type: "text", text: opts.text }], details };
}

function buildErrorResult(
	advisorLabel: string | undefined,
	effort: ThinkingLevel | undefined,
	userText: string,
	errorMessage: string,
): AgentToolResult<AdvisorDetails> {
	return buildAdvisorResult({ text: userText, effort, advisorLabel, errorMessage });
}

/**
 * Preserve the pre-patch error wording when only one candidate failed, so the
 * single-account case reads exactly as it did before the failover patch. Reasons
 * are the provider's own strings and never carry credentials or headers.
 */
function singleFailureText(failure: AdvisorAttemptFailure): string {
	if (failure.stage === "credentials") {
		return errMisconfigured(failure.label, failure.reason);
	}
	return errCallFailed(failure.reason);
}

// Terminal envelope for an aborted/error stopReason, or undefined when the
// attempt produced a normal stop whose text (or lack of text) the caller must
// still resolve. Used for the R6.4 empty-response retry, where an aborted/error
// second attempt must short-circuit rather than be treated as another empty
// response. `label` is the candidate that actually answered, not the configured
// primary — the details must name the account the tokens were spent on.
function stopReasonEnvelope(
	r: AssistantMessage,
	label: string,
	effort: ThinkingLevel | undefined,
): AgentToolResult<AdvisorDetails> | undefined {
	if (r.stopReason === "aborted") {
		return buildAdvisorResult({
			text: ERR_CALL_ABORTED,
			effort,
			advisorLabel: label,
			usage: r.usage,
			stopReason: r.stopReason,
			errorMessage: r.errorMessage ?? ERR_ABORTED_DETAIL,
		});
	}
	if (r.stopReason === "error") {
		return buildAdvisorResult({
			text: errCallFailed(r.errorMessage),
			effort,
			advisorLabel: label,
			usage: r.usage,
			stopReason: r.stopReason,
			errorMessage: r.errorMessage,
		});
	}
	return undefined;
}

export async function executeAdvisor(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<AdvisorDetails> | undefined,
): Promise<AgentToolResult<AdvisorDetails>> {
	// Snapshot effort once at entry — every result envelope and the API call
	// itself use this same value so a concurrent setAdvisorEffort() during the
	// await window cannot desync details.effort from the `reasoning` actually sent.
	const effort = getAdvisorEffort();
	const advisor = getAdvisorModel();
	if (!advisor) {
		return buildErrorResult(undefined, effort, ERR_NO_MODEL, ERR_NO_MODEL_SELECTED);
	}
	const advisorLabel = `${advisor.provider}:${advisor.id}`;

	// OAuth-backed providers resolve `{ ok: true }` with no literal apiKey — their
	// credentials are applied inside Pi's runtime facade. A missing key is only
	// fatal on legacy hosts without that facade, where the global completion
	// fallback needs the key passed explicitly.
	const runtimeCompleteSimple = getRuntimeCompleteSimple(ctx.modelRegistry);

	// Live-read every call — advisor runs mid-turn so any message_end snapshot
	// is always one turn stale. buildSessionContext() preserves Pi's resolved
	// LLM context, including compaction summaries and branch summaries, instead
	// of replaying raw pre-compaction branch messages. convertToLlm is
	// pass-through for user/assistant/toolResult (messages.js:111-114), so
	// element refs are stable across calls via the session store.
	const { messages: sessionMessages } = buildSessionContext(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getLeafId(),
	);
	const branchMessages = ensureUserTailForAdvisor(
		stripInflightAdvisorCall(stripToolDeclarations(convertToLlm(sessionMessages))),
	);
	const inventoryMessage = getInventoryMessage(pi.getAllTools());
	const messages: Message[] = inventoryMessage ? [inventoryMessage, ...branchMessages] : branchMessages;

	onUpdate?.({
		content: [{ type: "text", text: msgConsulting(advisorLabel, effort) }],
		details: { advisorModel: advisorLabel, effort },
	});

	// Candidate-independent work, hoisted out of the retry loop: the session
	// branch and tool inventory are identical for every account, and rebuilding
	// them per attempt would also risk the attempts diverging.
	let completeSimple: typeof import("@earendil-works/pi-ai/compat").completeSimple;
	try {
		// Prefer Pi's auth-aware runtime facade (resolved once above, before the
		// missing-key guard). Unlike the global compatibility function, it runs
		// request preparation and applies credential-derived fields such as GitHub
		// Copilot's OAuth-specific baseUrl. Do not pass the preflight key/headers
		// to this path: explicit overrides would bypass that resolution and
		// reintroduce the endpoint mismatch.
		completeSimple = runtimeCompleteSimple ?? (await loadCompleteSimple());
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return buildErrorResult(advisorLabel, effort, errCallThrew(message), message);
	}

	// LOCAL PATCH: account-level failover. The advisor's completion call bypasses
	// Pi's agent loop, so it emits no message_end/assistant_error events and any
	// account-rotation extension is blind to an advisor failure. Retrying the SAME
	// model id on a sibling account is therefore the only way a spent account
	// cannot take the advisor down. Candidates are [configured primary, ...siblings]
	// — the configured reviewer is never displaced by a different account.
	//
	// `getAll` is a host API that older hosts may not expose; falling back to the
	// primary alone degrades to the pre-patch single-account behaviour instead of
	// throwing.
	const available = ctx.modelRegistry.getAll?.() ?? [];
	const candidates = buildAdvisorCandidates(available, advisor);
	const failures: AdvisorAttemptFailure[] = [];

	// Resolve credentials PER CANDIDATE. Hoisting them would authenticate every
	// attempt with the primary's headers, i.e. keep hammering the account that just
	// refused while claiming to try its sibling.
	for (const candidate of candidates) {
		const label = `${candidate.provider}:${candidate.id}`;

		// Cancellation is re-checked before each attempt: a retry started after the
		// caller aborted would be another billable request nobody is waiting for.
		if (signal?.aborted) {
			return buildErrorResult(label, effort, ERR_CALL_ABORTED, ERR_ABORTED_DETAIL);
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate);
		if (!auth.ok) {
			failures.push({ label, stage: "credentials", reason: auth.error });
			continue;
		}
		if (!auth.apiKey && !runtimeCompleteSimple) {
			failures.push({
				label,
				stage: "credentials",
				reason: errNoApiKeyDetail(candidate.provider),
			});
			continue;
		}

		const requestOptions = runtimeCompleteSimple
			? { signal, reasoning: effort }
			: { apiKey: auth.apiKey, headers: auth.headers, signal, reasoning: effort };

		// Announce the candidate actually being consulted. Only the `advisorModel`
		// value changes between attempts — the update keeps its existing shape, and
		// `effort` stays the value snapshotted at entry.
		if (label !== advisorLabel) {
			onUpdate?.({
				content: [{ type: "text", text: msgConsulting(label, effort) }],
				details: { advisorModel: label, effort },
			});
		}

		// Single dispatch point — both attempts reuse the SAME `messages` and
		// `requestOptions`, so the retry cannot diverge from attempt 1. `tools: []`
		// plus stripToolDeclarations keeps the "never calls tools" contract: on
		// Pi >= 1.0 the transcript's system messages declare tools of their own.
		const callAdvisor = (): Promise<AssistantMessage> =>
			completeSimple(candidate, { systemPrompt: ADVISOR_SYSTEM_PROMPT, messages, tools: [] }, requestOptions);

		let response: AssistantMessage;
		try {
			response = await callAdvisor();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			// A thrown account refusal advances; a thrown transport/programming fault
			// does not — switching accounts cannot repair it and would risk re-sending
			// a request whose response was merely lost.
			if (isRetryableAdvisorError(message)) {
				failures.push({ label, stage: "threw", reason: message });
				continue;
			}
			return buildErrorResult(label, effort, errCallThrew(message), message);
		}

		// Evaluation order matters: aborted and error are terminal for THIS candidate
		// and must be classified BEFORE the empty-text retry below. Otherwise a quota
		// refusal that carried no text would be retried on the same spent account and
		// its actionable message replaced by a generic "empty response".
		if (response.stopReason === "aborted") {
			return buildAdvisorResult({
				text: ERR_CALL_ABORTED,
				effort,
				advisorLabel: label,
				usage: response.usage,
				stopReason: response.stopReason,
				errorMessage: response.errorMessage ?? ERR_ABORTED_DETAIL,
			});
		}
		if (response.stopReason === "error") {
			const message = response.errorMessage;
			if (isRetryableAdvisorError(message)) {
				failures.push({ label, stage: "call", reason: message ?? ERR_UNKNOWN });
				continue;
			}
			return buildAdvisorResult({
				text: errCallFailed(message),
				effort,
				advisorLabel: label,
				usage: response.usage,
				stopReason: response.stopReason,
				errorMessage: message,
			});
		}

		let advisorText = advisorTextFromResponse(response);

		// R6.4: a transient empty advisor response (normal stop, no text) gets
		// exactly ONE retry with identical inputs before surfacing as a terminal
		// error. Bounded to a single second call — never a `while`/loop — so a
		// persistent-empty provider cannot hot-loop. The retry budget is per
		// candidate, and no outer loop multiplies it. Unexplained empty output is
		// NOT an account fault, so it never advances to a sibling.
		if (!advisorText) {
			try {
				response = await callAdvisor();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return buildErrorResult(label, effort, errCallThrew(message), message);
			}

			const retryTerminal = stopReasonEnvelope(response, label, effort);
			if (retryTerminal) return retryTerminal;

			advisorText = advisorTextFromResponse(response);
			if (!advisorText) {
				return buildAdvisorResult({
					text: ERR_EMPTY_RESPONSE,
					effort,
					advisorLabel: label,
					usage: response.usage,
					stopReason: response.stopReason,
					errorMessage: ERR_EMPTY_RESPONSE_DETAIL,
				});
			}
		}

		return buildAdvisorResult({
			text: advisorText,
			effort,
			advisorLabel: label,
			usage: response.usage,
			stopReason: response.stopReason,
		});
	}

	// Every candidate refused. With a single candidate the original, more specific
	// error text is preserved verbatim (the common case: one configured advisor,
	// no siblings); only a genuine multi-account chain is aggregated.
	const aggregate =
		failures.length === 1
			? singleFailureText(failures[0])
			: errAllCandidatesFailed(failures);
	return buildErrorResult(advisorLabel, effort, aggregate, aggregate);
}
