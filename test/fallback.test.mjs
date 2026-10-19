/**
 * Behavioural tests for the rpiv-advisor account-failover patch.
 *
 * These run against the REAL execute.ts module with a stubbed host context, so
 * they assert on the actual decision logic (which candidate is tried, how many
 * calls happen, what the envelope says) rather than on a reimplementation.
 *
 * Staged and run by ../run-tests.mjs — imports resolve to the transpiled dist/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const MOD = new URL("../dist/execute.mjs", import.meta.url).href;
const FALLBACK = new URL("../dist/fallback.mjs", import.meta.url).href;
const STATE = new URL("../dist/state.mjs", import.meta.url).href;

const { advisorFamily, isSiblingProvider, buildAdvisorCandidates, isRetryableAdvisorError } = await import(
	FALLBACK
);

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("advisorFamily collapses numbered slots to the base family", () => {
	assert.equal(advisorFamily("openai-codex-account-2"), "openai-codex");
	assert.equal(advisorFamily("anthropic-account-11"), "anthropic");
	assert.equal(advisorFamily("openai-codex"), "openai-codex");
	// Not the slot convention -> untouched, so unrelated providers never merge.
	assert.equal(advisorFamily("openai-codex-account-x"), "openai-codex-account-x");
	assert.equal(advisorFamily("my-codex-clone"), "my-codex-clone");
});

test("isSiblingProvider admits the base provider as a sibling of a numbered slot", () => {
	assert.equal(isSiblingProvider("openai-codex-account-2", "openai-codex"), true);
	// The failover direction that matters when the SPENT account is the base.
	assert.equal(isSiblingProvider("openai-codex", "openai-codex"), true);
	assert.equal(isSiblingProvider("openai-codex-account-2", "anthropic"), false);
	assert.equal(isSiblingProvider("openai-codex-clone", "openai-codex"), false);
	// `family` is always the COLLAPSED family name (advisorFamily(primary)), never a
	// raw slot id, so a slot is not treated as its own sibling. Same-provider
	// dedup is handled by buildAdvisorCandidates.
	assert.equal(isSiblingProvider("openai-codex-account-2", "openai-codex-account-2"), false);
});

function model(provider, id) {
	return { provider, id, name: `${id} (${provider})` };
}

test("buildAdvisorCandidates pins the configured primary at the head", () => {
	const primary = model("openai-codex-account-2", "gpt-6-astra");
	const available = [
		model("openai-codex", "gpt-6-astra"),
		model("openai-codex-account-2", "gpt-6-astra"),
		model("openai-codex-account-3", "gpt-6-astra"),
	];
	const got = buildAdvisorCandidates(available, primary).map((m) => m.provider);
	// Primary first even though a lower-numbered slot exists.
	assert.deepEqual(got, ["openai-codex-account-2", "openai-codex", "openai-codex-account-3"]);
});

test("buildAdvisorCandidates never crosses models or families", () => {
	const primary = model("openai-codex", "gpt-6-astra");
	const available = [
		model("openai-codex-account-2", "gpt-6-astra"), // sibling: keep
		model("openai-codex-account-2", "gpt-5.6-sol"), // different model: drop
		model("anthropic-account-2", "gpt-6-astra"), // different family: drop
		model("openai-codex-account-2", "gpt-5.5"), // different model: drop
	];
	const got = buildAdvisorCandidates(available, primary).map((m) => `${m.provider}/${m.id}`);
	assert.deepEqual(got, ["openai-codex/gpt-6-astra", "openai-codex-account-2/gpt-6-astra"]);
});

test("buildAdvisorCandidates dedupes a provider exposed twice", () => {
	const primary = model("openai-codex", "gpt-6-astra");
	const available = [
		model("openai-codex-account-2", "gpt-6-astra"),
		model("openai-codex-account-2", "gpt-6-astra"),
	];
	const got = buildAdvisorCandidates(available, primary).map((m) => m.provider);
	assert.deepEqual(got, ["openai-codex", "openai-codex-account-2"]);
});

test("buildAdvisorCandidates degrades to the primary alone", () => {
	const primary = model("openai-codex", "gpt-6-astra");
	const got = buildAdvisorCandidates([], primary);
	assert.equal(got.length, 1);
	assert.equal(got[0].provider, "openai-codex");
});

// ---------------------------------------------------------------------------
// Classifier — the narrowness matters as much as the matches
// ---------------------------------------------------------------------------

test("isRetryableAdvisorError matches real account refusals", () => {
	const yes = [
		"Codex error: The usage limit has been reached",
		"You have hit your ChatGPT usage limit (team plan). Try again at 3:00 PM.",
		"429 Too Many Requests",
		"HTTP 402 Payment Required",
		"insufficient_quota",
		"Your credit balance is too low",
		"401 Unauthorized",
		"invalid api key",
		"token has expired",
		"authentication_error",
		// Verified against Codex's real credential-shape fault.
		"Failed to extract accountId from token",
	];
	for (const msg of yes) assert.equal(isRetryableAdvisorError(msg), true, `should match: ${msg}`);
});

test("isRetryableAdvisorError rejects service faults another account cannot fix", () => {
	const no = [
		"503 Service Unavailable",
		"overloaded_error",
		"Request timed out.",
		"fetch failed",
		"socket hang up",
		"ECONNRESET",
		// The bare-word traps the design review flagged:
		"insufficient context capacity",
		"expired request deadline",
		"service capacity exceeded",
		"unsupported billing configuration",
		// A bare number in an unrelated id must not trip the status patterns:
		"request id req_401ab99f",
		undefined,
		"",
	];
	for (const msg of no) assert.equal(isRetryableAdvisorError(msg), false, `should not match: ${msg}`);
});

// ---------------------------------------------------------------------------
// executeAdvisor — end-to-end against a stubbed host
// ---------------------------------------------------------------------------

const PRIMARY = model("openai-codex", "gpt-6-astra");
const SIBLING = model("openai-codex-account-2", "gpt-6-astra");

function assistant(overrides = {}) {
	return {
		content: [{ type: "text", text: "do the thing" }],
		stopReason: "stop",
		usage: { input: 1, output: 1 },
		...overrides,
	};
}

/**
 * Build a stubbed ExtensionContext + ExtensionAPI.
 * `responses` is consulted per call index; an Error value is thrown.
 */
function harness({ responses, models = [PRIMARY, SIBLING], authFail = {} }) {
	const calls = [];
	const authCalls = [];
	const updates = [];
	const byProvider = new Map(models.map((m) => [m.provider, m]));

	const ctx = {
		modelRegistry: {
			getAll: () => models,
			find: (provider, id) => byProvider.get(provider) ?? undefined,
			getApiKeyAndHeaders: async (m) => {
				authCalls.push(m.provider);
				if (authFail[m.provider]) return { ok: false, error: authFail[m.provider] };
				return { ok: true, apiKey: `key-${m.provider}`, headers: { "x-account": m.provider } };
			},
		},
		sessionManager: { getEntries: () => [], getLeafId: () => undefined },
	};
	const pi = { getAllTools: () => [] };

	const index = { i: 0 };
	const completeSimple = async (m, _ctx, options) => {
		calls.push({ provider: m.provider, id: m.id, options });
		const next = responses[Math.min(index.i++, responses.length - 1)];
		if (next instanceof Error) throw next;
		return next;
	};

	return { ctx, pi, calls, authCalls, updates, completeSimple };
}

/** Set the module-level advisor selection and run executeAdvisor with the stub. */
async function run(stub, { signal, primary = PRIMARY } = {}) {
	const { executeAdvisor } = await import(MOD);
	const state = await import(STATE);
	state.setAdvisorModel(primary);
	state.setAdvisorEffort("low");

	const ctx = {
		...stub.ctx,
		modelRegistry: { ...stub.ctx.modelRegistry, runtime: { completeSimple: stub.completeSimple } },
	};
	return executeAdvisor(ctx, stub.pi, signal, (u) => stub.updates.push(u));
}

test("quota refusal on the primary fails over to the sibling", async () => {
	const stub = harness({
		responses: [
			assistant({ content: [], stopReason: "error", errorMessage: "The usage limit has been reached" }),
			assistant(),
		],
	});
	const res = await run(stub);

	assert.equal(stub.calls.length, 2, "must call exactly twice");
	assert.deepEqual(stub.calls.map((c) => c.provider), ["openai-codex", "openai-codex-account-2"]);
	// Credentials must be resolved PER CANDIDATE, not reused from the primary:
	// reusing the primary's headers would keep hammering the spent account.
	assert.deepEqual(stub.authCalls, ["openai-codex", "openai-codex-account-2"]);
	assert.equal(res.details.advisorModel, "openai-codex-account-2:gpt-6-astra");
	assert.equal(res.details.effort, "low");
	assert.match(res.content[0].text, /do the thing/);
});

test("non-retryable error does NOT spend a sibling", async () => {
	const stub = harness({
		responses: [assistant({ content: [], stopReason: "error", errorMessage: "503 Service Unavailable" })],
	});
	const res = await run(stub);

	assert.equal(stub.calls.length, 1, "a service fault must not try another account");
	assert.equal(res.details.advisorModel, "openai-codex:gpt-6-astra");
	assert.match(res.content[0].text, /503 Service Unavailable/);
});

test("thrown quota error advances, thrown network error does not", async () => {
	const advancing = harness({ responses: [new Error("429 Too Many Requests"), assistant()] });
	await run(advancing);
	assert.equal(advancing.calls.length, 2, "thrown 429 should advance");
	assert.equal(advancing.calls[1].provider, "openai-codex-account-2");

	const stopping = harness({ responses: [new Error("fetch failed")] });
	const res = await run(stopping);
	assert.equal(stopping.calls.length, 1, "thrown transport error must not advance");
	assert.match(res.content[0].text, /fetch failed/);
});

test("an errored response with no text is NOT mistaken for an empty response", async () => {
	// The regression the design review predicted: empty-check before error-check
	// would retry the same spent account and replace the real message.
	const stub = harness({
		responses: [
			assistant({ content: [], stopReason: "error", errorMessage: "The usage limit has been reached" }),
			assistant(),
		],
	});
	const res = await run(stub);

	assert.equal(stub.calls.length, 2);
	assert.deepEqual(stub.calls.map((c) => c.provider), ["openai-codex", "openai-codex-account-2"]);
	assert.equal(res.details.stopReason, "stop");
	// The actionable quota text must not have leaked out as "empty response".
	assert.doesNotMatch(JSON.stringify(res), /no text content/);
});

test("abort stops immediately and never advances", async () => {
	const stub = harness({
		responses: [assistant({ content: [], stopReason: "aborted" }), assistant()],
	});
	const res = await run(stub);

	assert.equal(stub.calls.length, 1, "an abort must not start another billable request");
	assert.equal(res.details.stopReason, "aborted");
});

test("a pre-aborted signal issues zero calls", async () => {
	const stub = harness({ responses: [assistant()] });
	const controller = new AbortController();
	controller.abort();
	const res = await run(stub, { signal: controller.signal });

	assert.equal(stub.calls.length, 0, "cancelled call must not reach the provider");
	assert.match(res.content[0].text, /cancelled/i);
});

test("empty response retries once on the SAME account, then succeeds", async () => {
	const stub = harness({
		responses: [assistant({ content: [] }), assistant({ content: [{ type: "text", text: "second try" }] })],
	});
	const res = await run(stub);

	assert.equal(stub.calls.length, 2);
	assert.deepEqual(stub.calls.map((c) => c.provider), ["openai-codex", "openai-codex"]);
	assert.match(res.content[0].text, /second try/);
});

test("empty twice is terminal and does NOT fail over", async () => {
	const stub = harness({ responses: [assistant({ content: [] }), assistant({ content: [] })] });
	const res = await run(stub);

	assert.equal(stub.calls.length, 2, "R6.4 budget is one retry, and empty output is not an account fault");
	assert.deepEqual(stub.calls.map((c) => c.provider), ["openai-codex", "openai-codex"]);
	assert.equal(res.details.errorMessage, "empty response");
});

test("account-2 as primary keeps its head position and fails over to base", async () => {
	const stub = harness({
		responses: [
			assistant({ content: [], stopReason: "error", errorMessage: "usage limit reached" }),
			assistant(),
		],
	});
	const res = await run(stub, { primary: SIBLING });

	assert.deepEqual(stub.calls.map((c) => c.provider), ["openai-codex-account-2", "openai-codex"]);
	assert.equal(res.details.advisorModel, "openai-codex:gpt-6-astra");
});

test("all accounts exhausted aggregates every attempt", async () => {
	const stub = harness({
		responses: [assistant({ content: [], stopReason: "error", errorMessage: "usage limit reached" })],
	});
	const res = await run(stub);

	assert.equal(stub.calls.length, 2, "both candidates tried");
	const text = res.content[0].text;
	assert.match(text, /every configured account/);
	assert.match(text, /openai-codex:gpt-6-astra/);
	assert.match(text, /openai-codex-account-2:gpt-6-astra/);
});

test("credential failure on the primary advances to the sibling", async () => {
	const stub = harness({
		responses: [assistant()],
		authFail: { "openai-codex": "no credential stored" },
	});
	const res = await run(stub);

	assert.equal(stub.calls.length, 1, "the failed-credential candidate is skipped, not called");
	assert.equal(stub.calls[0].provider, "openai-codex-account-2");
	assert.equal(res.details.advisorModel, "openai-codex-account-2:gpt-6-astra");
});

test("single-account credential failure keeps the original wording", async () => {
	const stub = harness({
		responses: [assistant()],
		models: [PRIMARY],
		authFail: { "openai-codex": "no credential stored" },
	});
	const res = await run(stub);

	assert.equal(stub.calls.length, 0);
	assert.match(res.content[0].text, /is misconfigured: no credential stored/);
});

test("the whole chain never exceeds 2 calls per candidate", async () => {
	const stub = harness({
		responses: [assistant({ content: [], stopReason: "error", errorMessage: "usage limit" })],
	});
	await run(stub);
	// 2 candidates x 1 call each = 2. An outer retry wrapping the loop would show 4.
	assert.equal(stub.calls.length, 2);
});

test("onUpdate reports the candidate actually being consulted", async () => {
	const stub = harness({
		responses: [
			assistant({ content: [], stopReason: "error", errorMessage: "usage limit reached" }),
			assistant(),
		],
	});
	await run(stub);

	const labels = stub.updates.map((u) => u.details.advisorModel);
	assert.ok(labels.includes("openai-codex:gpt-6-astra"));
	assert.ok(labels.includes("openai-codex-account-2:gpt-6-astra"));
	// Progress updates must not corrupt the effort contract.
	for (const u of stub.updates) assert.equal(u.details.effort, "low");
});

// ---------------------------------------------------------------------------
// Upstream 2.13.8 — #295 (stripToolDeclarations)
// ---------------------------------------------------------------------------

const CONTEXT = new URL("../dist/context.mjs", import.meta.url).href;
const { stripToolDeclarations } = await import(CONTEXT);

test("stripToolDeclarations drops tool loadout deltas but keeps prompt text", () => {
	const msgs = [
		{ role: "system", content: "preamble", toolsAdded: [{ name: "bash" }], timestamp: 1 },
		{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 2 },
		{
			role: "system",
			content: "more",
			toolsRemoved: [{ name: "read" }],
			toolsAdded: [{ name: "edit" }],
			timestamp: 3,
		},
	];
	const out = stripToolDeclarations(msgs);

	// Deltas gone — this is what stops the advisor from stopping on toolUse.
	for (const m of out) {
		assert.equal(m.toolsAdded, undefined);
		assert.equal(m.toolsRemoved, undefined);
	}
	// Prompt text and every other field preserved.
	assert.equal(out[0].content, "preamble");
	assert.equal(out[2].content, "more");
	assert.equal(out[0].timestamp, 1);
	assert.equal(out.length, 3);
});

test("stripToolDeclarations is identity when no declarative system message exists", () => {
	const msgs = [
		{ role: "system", content: "plain", timestamp: 1 },
		{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 2 },
	];
	// Same array reference — the no-op path must not copy.
	assert.equal(stripToolDeclarations(msgs), msgs);
});
