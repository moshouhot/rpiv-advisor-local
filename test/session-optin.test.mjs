/**
 * Behavioural tests for the per-session advisor opt-in gate.
 *
 * The gate is the feature that keeps the advisor OFF until the user explicitly
 * asks for it in a given session ("调用 advisor"). Two things can go wrong and
 * both are covered here:
 *
 *   1. The keyword matcher fires on a question or — worse — on a NEGATED
 *      imperative ("不要调用 advisor"), silently enabling the tool the user just
 *      forbade.
 *   2. The grant leaks across sessions, so one opt-in turns the advisor on for
 *      every later session in the same process.
 *
 * Staged and run by ../run-tests.mjs — imports resolve to the transpiled dist/.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

const OPTIN = new URL("../dist/session-optin.mjs", import.meta.url).href;

const {
	detectOptInRequest,
	isSessionOptedIn,
	optInSession,
	resetSessionOptIn,
	__resetAllSessionOptIns,
} = await import(OPTIN);

// Lab mode's real check reads a flag file on disk, so running this suite with
// the lab environment actually on would fail unrelated tests. Pin it OFF here,
// at the very top, BEFORE any `test()` is registered: neither a top-level
// `before()` hook nor a late `await import` is guaranteed to run first, because
// node:test starts the root suite as soon as registration is possible.
const LAB = new URL("../dist/lab-mode.mjs", import.meta.url).href;
const { isLabModeActive, __setLabModeOverride, LAB_MODE_FLAG_PATH } = await import(LAB);
__setLabModeOverride(false);

/** Inputs that MUST grant the session. */
const GRANTS = [
	"调用 advisor",
	"调用advisor",
	"请 Advisor 指导一下。",
	"请advisor指导一下",
	"让 advisor 看看这段代码",
	"用一下 advisor",
	"启用 advisor",
	"开启 advisor",
	"打开 advisor",
	"找 advisor 判断",
	"叫 advisor 来审查",
	"先调用 advisor，再继续",
	"这个方案，请 advisor 评估一下",
	"call the advisor",
	"use advisor",
	"Please ask advisor to review this",
];

/**
 * Inputs that must NOT grant. The negation cases are the load-bearing ones:
 * the user's "do not use the advisor" instruction has to survive the very
 * mechanism that watches for "use the advisor".
 */
const REFUSALS = [
	"不要调用 advisor",
	"不用启用 advisor",
	"别用 advisor",
	"禁止使用 advisor",
	"不想用 advisor",
	"don't call the advisor",
	"do not use advisor",
	"never use advisor",
	"advisor 是什么？",
	"advisor 太慢了",
	"上次 advisor 说了什么",
	"Advisor 的输出有时候不准",
	"这个 advisor 挺有用",
	"我想知道 advisor 怎么工作",
	"",
	"今天天气不错",
];

test("detectOptInRequest grants on explicit imperative requests", () => {
	for (const text of GRANTS) {
		assert.equal(detectOptInRequest(text).matched, true, `should grant: ${JSON.stringify(text)}`);
	}
});

test("detectOptInRequest ignores questions, remarks, and negated imperatives", () => {
	for (const text of REFUSALS) {
		assert.equal(detectOptInRequest(text).matched, false, `should refuse: ${JSON.stringify(text)}`);
	}
});

test("detectOptInRequest reports the matched verb for diagnostics", () => {
	assert.equal(detectOptInRequest("调用 advisor").verb, "调用");
	assert.equal(detectOptInRequest("请 advisor 看一下").verb, "请");
	assert.equal(detectOptInRequest("call the advisor").verb, "call");
	assert.equal(detectOptInRequest("今天天气不错").verb, undefined);
});

test("a session is closed until it is explicitly opted in", () => {
	__resetAllSessionOptIns();
	assert.equal(isSessionOptedIn("session-a"), false);
	optInSession("session-a");
	assert.equal(isSessionOptedIn("session-a"), true);
});

test("a grant never leaks into another session", () => {
	__resetAllSessionOptIns();
	optInSession("session-a");
	assert.equal(isSessionOptedIn("session-a"), true);
	assert.equal(isSessionOptedIn("session-b"), false, "grant must be scoped to one session id");
});

test("resetSessionOptIn closes exactly one session", () => {
	__resetAllSessionOptIns();
	optInSession("session-a");
	optInSession("session-b");
	resetSessionOptIn("session-a");
	assert.equal(isSessionOptedIn("session-a"), false);
	assert.equal(isSessionOptedIn("session-b"), true, "resetting one session must not touch another");
});

test("an unknown or missing session id is always closed", () => {
	__resetAllSessionOptIns();
	optInSession(undefined);
	assert.equal(isSessionOptedIn(undefined), false);
	optInSession("");
	assert.equal(isSessionOptedIn(""), false);
	resetSessionOptIn(undefined);
	resetSessionOptIn("");
});

// ---------------------------------------------------------------------------
// Gate wiring: reconcileAdvisorTool must honour the session grant, and the
// status-bar indicator must track it. Exercised with a fake host so the tests
// assert on the real module, not a reimplementation.
// ---------------------------------------------------------------------------

const HANDLERS = new URL("../dist/handlers.mjs", import.meta.url).href;
const { reconcileAdvisorTool, refreshAdvisorStatus, ADVISOR_STATUS_KEY } = await import(HANDLERS);

/** Minimal stand-in for the Pi host: active tool list + recorded status writes. */
function fakeHost(active = []) {
	const activeTools = [...active];
	const statuses = [];
	const pi = {
		getActiveTools: () => [...activeTools],
		setActiveTools: (next) => {
			activeTools.length = 0;
			activeTools.push(...next);
		},
	};
	const ctx = {
		hasUI: true,
		model: undefined,
		ui: {
			notify: () => {},
			setStatus: (key, text) => statuses.push({ key, text }),
		},
		sessionManager: { getSessionId: () => "sid" },
	};
	return { pi, ctx, activeTools, statuses };
}

test("reconcile strips the tool when the session has not opted in", () => {
	__resetAllSessionOptIns();
	const { pi, ctx, activeTools } = fakeHost(["bash", "advisor"]);
	reconcileAdvisorTool(pi, ctx, { blocked: false });
	assert.deepEqual(activeTools, ["bash"], "advisor must not survive without a grant");
});

test("reconcile keeps the tool once the session has opted in", () => {
	__resetAllSessionOptIns();
	optInSession("sid");
	const { pi, ctx, activeTools } = fakeHost(["bash"]);
	reconcileAdvisorTool(pi, ctx, { blocked: false });
	assert.deepEqual(activeTools, ["bash", "advisor"]);
});

test("an unrelated block reason still wins over a grant", () => {
	__resetAllSessionOptIns();
	optInSession("sid");
	const { pi, ctx, activeTools } = fakeHost(["bash", "advisor"]);
	reconcileAdvisorTool(pi, ctx, { blocked: true });
	assert.deepEqual(activeTools, ["bash"], "blocked must strip even with a grant");
});

test("status indicator is shown only while the grant is active", () => {
	__resetAllSessionOptIns();
	const on = fakeHost();
	optInSession("sid");
	refreshAdvisorStatus(on.ctx, "sid");
	assert.deepEqual(on.statuses.at(-1), { key: ADVISOR_STATUS_KEY, text: "advisor: on" });

	const off = fakeHost();
	__resetAllSessionOptIns();
	refreshAdvisorStatus(off.ctx, "sid");
	assert.deepEqual(off.statuses.at(-1), { key: ADVISOR_STATUS_KEY, text: undefined }, "must clear, not leave stale text");
});

// ---------------------------------------------------------------------------
// Lab mode: an absolute prohibition, not just another block reason.
// ---------------------------------------------------------------------------

// Lab tests below flip the override on and restore to `false` (never
// `undefined`, which would fall back to the file mid-suite).

test("lab mode reads a flag shared with security-audit-interceptor", () => {
	assert.match(LAB_MODE_FLAG_PATH, /lab-mode\.flag$/, "path must match the interceptor's LAB_FLAG_PATH");
});

test("lab mode strips the advisor even when the session holds a grant", () => {
	__resetAllSessionOptIns();
	optInSession("sid");
	const { pi, ctx, activeTools } = fakeHost(["bash", "advisor"]);
	__setLabModeOverride(true);
	try {
		reconcileAdvisorTool(pi, ctx, { blocked: false });
		assert.deepEqual(activeTools, ["bash"], "lab must override a grant");
	} finally {
		__setLabModeOverride(false);
	}
});

test("before_agent_start suspends rather than revokes while lab mode is on", async () => {
	const handlers = await import(HANDLERS);
	const STATE = await import(new URL("../dist/state.mjs", import.meta.url).href);
	STATE.setAdvisorModel({ provider: "openai-codex", id: "gpt-6.1-sol" });

	__resetAllSessionOptIns();
	recordGrant(undefined, "sid", true);
	assert.equal(isSessionOptedIn("sid"), true);

	const { pi, ctx, activeTools } = fakeHost(["bash", "advisor"]);
	let handler;
	pi.getThinkingLevel = () => "high";
	pi.on = (name, fn) => {
		if (name === "before_agent_start") handler = fn;
		return () => {};
	};
	handlers.registerAdvisorBeforeAgentStart(pi);
	assert.ok(handler);

	__setLabModeOverride(true);
	try {
		await handler({ type: "before_agent_start" }, ctx);
		// Suspension, not revocation: "always on" has to recover on its own once
		// the lab flag disappears, which a false record would prevent forever.
		assert.equal(isSessionOptedIn("sid"), true, "lab must not revoke the grant");
		assert.deepEqual(activeTools, ["bash"], "tool stripped in the same turn");

		__setLabModeOverride(false);
		await handler({ type: "before_agent_start" }, ctx);
		assert.ok(activeTools.includes("advisor"), "leaving lab restores the advisor");
	} finally {
		__setLabModeOverride(false);
		STATE.setAdvisorModel(undefined);
	}
});
test("status says why the advisor is off during lab mode", () => {
	__resetAllSessionOptIns();
	optInSession("sid");
	const { ctx, statuses } = fakeHost();
	__setLabModeOverride(true);
	try {
		refreshAdvisorStatus(ctx, "sid");
		assert.deepEqual(statuses.at(-1), { key: ADVISOR_STATUS_KEY, text: "advisor: off (lab mode)" });
	} finally {
		__setLabModeOverride(false);
	}
});

test("the opt-in keyword is refused while lab mode is active", async () => {
	__resetAllSessionOptIns();
	const handlers = await import(HANDLERS);
	const { pi, ctx } = fakeHost(["bash"]);
	let handler;
	pi.on = (name, fn) => {
		if (name === "input") handler = fn;
		return () => {};
	};
	handlers.registerInputOptInHandler(pi);
	assert.ok(handler, "input handler must be registered");

	__setLabModeOverride(true);
	try {
		const result = await handler({ type: "input", text: "调用 advisor", source: "interactive" }, ctx);
		assert.equal(result.action, "continue", "must never rewrite the user's text");
		assert.equal(isSessionOptedIn("sid"), false, "lab mode must refuse the grant");
	} finally {
		__setLabModeOverride(false);
	}
	assert.equal(isLabModeActive(), false);
});

// ---------------------------------------------------------------------------
// /advisor on | off — the command-line counterpart of the opt-in keyword.
// ---------------------------------------------------------------------------

const COMMAND = new URL("../dist/command.mjs", import.meta.url).href;
const POLICY = new URL("../dist/policy.mjs", import.meta.url).href;

/**
 * Capture the command registration so the handler can be invoked directly.
 *
 * `pi` must be the SAME object the assertions inspect: the handler closes over
 * the `pi` passed to registerAdvisorCommand, so passing a throwaway host here
 * would make activeTools assertions read a different list than the one the
 * implementation mutates.
 */
async function loadAdvisorCommand(host) {
	const { registerAdvisorCommand } = await import(COMMAND);
	const { setDisabledForModels } = await import(POLICY);
	setDisabledForModels([]);
	let spec;
	const pi = {
		getActiveTools: host?.getActiveTools ?? (() => []),
		setActiveTools: host?.setActiveTools ?? (() => {}),
		getThinkingLevel: host?.getThinkingLevel ?? (() => "high"),
		registerCommand: (_name, s) => {
			spec = s;
		},
	};
	registerAdvisorCommand(pi);
	return spec;
}

function commandHost(active = ["bash"]) {
	const activeTools = [...active];
	const calls = [];
	const pi = {
		getActiveTools: () => [...activeTools],
		setActiveTools: (next) => {
			activeTools.length = 0;
			activeTools.push(...next);
		},
		getThinkingLevel: () => "high",
	};
	const statuses = [];
	const notes = [];
	const ctx = {
		hasUI: true,
		model: undefined,
		ui: {
			notify: (m, lvl) => notes.push({ m, lvl }),
			setStatus: (k, t) => statuses.push({ k, t }),
		},
		sessionManager: { getSessionId: () => "sid" },
	};
	return { pi, ctx, activeTools, statuses, notes };
}

test("/advisor exposes on, off and the always variants as completions", async () => {
	const spec = await loadAdvisorCommand();
	const values = (await spec.getArgumentCompletions("")).map((i) => i.value).sort();
	assert.deepEqual(values, ["always off", "always on", "off", "on"]);
	// "o" matches both on/off; "always " narrows to the persistent pair.
	assert.deepEqual((await spec.getArgumentCompletions("o")).map((i) => i.value).sort(), ["off", "on"]);
	assert.deepEqual((await spec.getArgumentCompletions("of")).map((i) => i.value), ["off"]);
	assert.deepEqual((await spec.getArgumentCompletions("always ")).map((i) => i.value).sort(), [
		"always off",
		"always on",
	]);
});

test("/advisor off revokes the session grant but keeps the configured model", async () => {
	const STATE = await import(new URL("../dist/state.mjs", import.meta.url).href);
	STATE.setAdvisorModel({ provider: "openai-codex", id: "gpt-6.1-sol" });
	STATE.setAdvisorEffort("max");
	__resetAllSessionOptIns();
	optInSession("sid");

	const { pi, ctx, activeTools, notes } = commandHost(["bash", "advisor"]);
	const spec = await loadAdvisorCommand(pi);
	await spec.handler("off", ctx);

	assert.equal(isSessionOptedIn("sid"), false, "grant must be revoked");
	assert.deepEqual(activeTools, ["bash"], "tool must be stripped");
	assert.notEqual(STATE.getAdvisorModel(), undefined, "model must survive — that is what /advisor off means");
	assert.match(notes.at(-1).m, /off for this session/i);
	STATE.setAdvisorModel(undefined);
});

test("/advisor on re-grants the session once a model is configured", async () => {
	const STATE = await import(new URL("../dist/state.mjs", import.meta.url).href);
	STATE.setAdvisorModel({ provider: "openai-codex", id: "gpt-6.1-sol" });
	STATE.setAdvisorEffort("max");
	__resetAllSessionOptIns();

	const { pi, ctx, activeTools, statuses } = commandHost(["bash"]);
	const spec = await loadAdvisorCommand(pi);
	await spec.handler("on", ctx);

	assert.equal(isSessionOptedIn("sid"), true, "grant must be created");
	assert.ok(activeTools.includes("advisor"), "tool must be activated");
	assert.deepEqual(statuses.at(-1), { k: ADVISOR_STATUS_KEY, t: "advisor: on" });
	STATE.setAdvisorModel(undefined);
});

test("/advisor on refuses when no model is configured", async () => {
	const STATE = await import(new URL("../dist/state.mjs", import.meta.url).href);
	STATE.setAdvisorModel(undefined);
	__resetAllSessionOptIns();

	const { pi, ctx, activeTools, notes } = commandHost(["bash"]);
	const spec = await loadAdvisorCommand(pi);
	await spec.handler("on", ctx);

	assert.equal(isSessionOptedIn("sid"), false, "must not grant without a model");
	assert.deepEqual(activeTools, ["bash"]);
	assert.match(notes.at(-1).m, /no model configured/i);
	assert.equal(notes.at(-1).lvl, "error");
});

test("/advisor on refuses in lab mode and says why", async () => {
	const STATE = await import(new URL("../dist/state.mjs", import.meta.url).href);
	STATE.setAdvisorModel({ provider: "openai-codex", id: "gpt-6.1-sol" });
	__resetAllSessionOptIns();

	const { pi, ctx, activeTools, notes } = commandHost(["bash"]);
	const spec = await loadAdvisorCommand(pi);
	__setLabModeOverride(true);
	try {
		await spec.handler("on", ctx);
		assert.equal(isSessionOptedIn("sid"), false, "lab mode must refuse the grant");
		assert.deepEqual(activeTools, ["bash"]);
		assert.match(notes.at(-1).m, /lab/i);
	} finally {
		__setLabModeOverride(false);
		STATE.setAdvisorModel(undefined);
	}
});

test("/advisor rejects an unknown argument instead of opening the picker", async () => {
	const { pi, ctx, notes } = commandHost(["bash"]);
	const spec = await loadAdvisorCommand(pi);
	await spec.handler("bogus", ctx);
	assert.match(notes.at(-1).m, /unknown \/advisor argument/i);
	assert.equal(notes.at(-1).lvl, "error");
});

// ---------------------------------------------------------------------------
// Persistence: a reload replaces the extension runtime, so the in-memory Set is
// empty afterwards. The grant must be rebuilt from the session's own entries.
// ---------------------------------------------------------------------------

const { recordSessionOptIn: recordGrant, restoreSessionOptIn, OPTIN_ENTRY_TYPE } = await import(OPTIN);

/** Fake session manager exposing just the entry readers restoreSessionOptIn uses. */
function sessionWith(entries) {
	return { getBranch: () => entries };
}
const grantEntry = (enabled) => ({ type: "custom", customType: OPTIN_ENTRY_TYPE, data: { enabled } });

test("a reload rebuilds the grant from the session entries", () => {
	__resetAllSessionOptIns(); // simulates the fresh module state after /reload
	assert.equal(isSessionOptedIn("sid"), false, "reload really does empty the Set");

	// What the previous runtime appended before the reload:
	const restored = restoreSessionOptIn(sessionWith([grantEntry(true)]), "sid");
	assert.equal(restored, true);
	assert.equal(isSessionOptedIn("sid"), true, "grant must survive the reload");
});

test("the newest entry wins after repeated toggling", () => {
	__resetAllSessionOptIns();
	restoreSessionOptIn(sessionWith([grantEntry(true), grantEntry(false), grantEntry(true)]), "sid");
	assert.equal(isSessionOptedIn("sid"), true);
	__resetAllSessionOptIns();
	restoreSessionOptIn(sessionWith([grantEntry(true), grantEntry(false)]), "sid");
	assert.equal(isSessionOptedIn("sid"), false, "last intent is off");
});

test("unrelated custom entries are ignored", () => {
	__resetAllSessionOptIns();
	const restored = restoreSessionOptIn(
		sessionWith([
			{ type: "custom", customType: "some-other-extension", data: { enabled: true } },
			{ type: "message", role: "user" },
		]),
		"sid",
	);
	assert.equal(restored, undefined, "no record of ours => undefined, not false");
	assert.equal(isSessionOptedIn("sid"), false);
});

test("a session with no record reports undefined so the default can apply", () => {
	__resetAllSessionOptIns();
	assert.equal(restoreSessionOptIn(sessionWith([]), "sid"), undefined);
});

test("recordSessionOptIn both updates memory and appends an entry", () => {
	__resetAllSessionOptIns();
	const appended = [];
	const pi = { appendEntry: (customType, data) => appended.push({ customType, data }) };

	recordGrant(pi, "sid", true);
	assert.equal(isSessionOptedIn("sid"), true);
	assert.deepEqual(appended.at(-1), { customType: OPTIN_ENTRY_TYPE, data: { enabled: true } });

	recordGrant(pi, "sid", false);
	assert.equal(isSessionOptedIn("sid"), false);
	assert.deepEqual(appended.at(-1), { customType: OPTIN_ENTRY_TYPE, data: { enabled: false } });
});

test("recording survives a host that cannot persist (--no-session)", () => {
	__resetAllSessionOptIns();
	const pi = {
		appendEntry: () => {
			throw new Error("no session");
		},
	};
	recordGrant(pi, "sid", true);
	assert.equal(isSessionOptedIn("sid"), true, "failure to persist must not drop the in-memory grant");
});

// ---------------------------------------------------------------------------
// Lab suspension vs. revocation.
//
// Lab mode must SUSPEND the advisor, not revoke the grant: "always on" has to
// come back by itself once the flag disappears. An earlier implementation wrote
// `{enabled:false}` on entering lab, which — because a session record outranks
// the configured default — made the suspension permanent. These tests walk the
// same-session sequence that the old two-process tests could not detect.
// ---------------------------------------------------------------------------

/** Fake pi that records appended entries, plus the host the handlers need. */
function lifecycleHost(active = ["bash"]) {
	const appended = [];
	const activeTools = [...active];
	const pi = {
		getActiveTools: () => [...activeTools],
		setActiveTools: (next) => {
			activeTools.length = 0;
			activeTools.push(...next);
		},
		getThinkingLevel: () => "high",
		appendEntry: (customType, data) => appended.push({ customType, data }),
	};
	const ctx = {
		hasUI: true,
		model: undefined,
		ui: { notify: () => {}, setStatus: () => {} },
		sessionManager: {
			getSessionId: () => "sid",
			getBranch: () => appended.filter((e) => e.customType === OPTIN_ENTRY_TYPE).map((e) => ({
				type: "custom",
				customType: e.customType,
				data: e.data,
			})),
		},
	};
	return { pi, ctx, activeTools, appended };
}

test("lab blocks the tool but leaves the grant intact (suspend, not revoke)", async () => {
	const handlers = await import(HANDLERS);
	const STATE = await import(new URL("../dist/state.mjs", import.meta.url).href);
	STATE.setAdvisorModel({ provider: "openai-codex", id: "gpt-6.1-sol" });
	__resetAllSessionOptIns();
	recordGrant(undefined, "sid", true);

	const { pi, ctx, activeTools } = lifecycleHost(["bash", "advisor"]);
	let handler;
	pi.on = (name, fn) => {
		if (name === "before_agent_start") handler = fn;
		return () => {};
	};
	handlers.registerAdvisorBeforeAgentStart(pi);

	__setLabModeOverride(true);
	try {
		await handler({ type: "before_agent_start" }, ctx);
		assert.deepEqual(activeTools, ["bash"], "lab strips the tool");
		assert.equal(isSessionOptedIn("sid"), true, "but the grant must survive");

		// Leaving lab restores it with NO new opt-in.
		__setLabModeOverride(false);
		await handler({ type: "before_agent_start" }, ctx);
		assert.ok(activeTools.includes("advisor"), "leaving lab must restore the advisor automatically");
	} finally {
		__setLabModeOverride(false);
		STATE.setAdvisorModel(undefined);
	}
});

test("entering and leaving lab never writes a false grant record", async () => {
	const handlers = await import(HANDLERS);
	const STATE = await import(new URL("../dist/state.mjs", import.meta.url).href);
	STATE.setAdvisorModel({ provider: "openai-codex", id: "gpt-6.1-sol" });
	__resetAllSessionOptIns();
	recordGrant(undefined, "sid", true);

	const { pi, ctx, appended } = lifecycleHost(["bash", "advisor"]);
	let handler;
	pi.on = (name, fn) => {
		if (name === "before_agent_start") handler = fn;
		return () => {};
	};
	handlers.registerAdvisorBeforeAgentStart(pi);

	__setLabModeOverride(true);
	await handler({ type: "before_agent_start" }, ctx);
	__setLabModeOverride(false);
	await handler({ type: "before_agent_start" }, ctx);

	assert.equal(appended.length, 0, "lab transitions must not append records — a false record outranks the default forever");
	STATE.setAdvisorModel(undefined);
});

test("a reload during lab still restores the advisor after the flag is gone", async () => {
	const STATE = await import(new URL("../dist/state.mjs", import.meta.url).href);
	STATE.setAdvisorModel({ provider: "openai-codex", id: "gpt-6.1-sol" });

	// Session had an explicit grant before lab started.
	__resetAllSessionOptIns();
	recordGrant(undefined, "sid", true);
	const entries = [grantEntry(true)];

	__setLabModeOverride(true);
	try {
		// Reload while lab is on: the grant rebuilds true, the tool stays blocked.
		__resetAllSessionOptIns();
		const rebuilt = restoreSessionOptIn(sessionWith(entries), "sid");
		assert.equal(rebuilt, true, "reload inside lab still rebuilds the grant");
		assert.equal(isSessionOptedIn("sid"), true);
	} finally {
		__setLabModeOverride(false);
	}
	// After lab ends, the same rebuilt grant is usable again.
	assert.equal(isSessionOptedIn("sid"), true);
	STATE.setAdvisorModel(undefined);
});
