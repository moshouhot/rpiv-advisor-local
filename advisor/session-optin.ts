/**
 * session-optin — per-session activation gate for the advisor tool.
 *
 * Default is OFF: every session starts without the advisor, and the tool only
 * becomes available after the user explicitly asks for it in that session
 * ("调用 advisor", "请 advisor 指导一下", ...). The grant is scoped to a single
 * session id and never persists to disk — a new process, a new session, or a
 * resume under a fresh id all start closed, which is exactly the requested
 * "default off, opt in per session" behaviour.
 *
 * Why in-memory only: persisting the grant would recreate "last time I enabled
 * it, so it is enabled again" — the failure mode this module exists to remove.
 */

/** Phrases that count as an explicit opt-in request, paired with the verb that matched. */
export interface OptInMatch {
	matched: boolean;
	/** The verb that triggered the match, for diagnostics. Undefined when not matched. */
	verb?: string;
}

/** Advisor subject aliases. Deliberately narrow: bare "顾问" is too generic to gate on its own. */
const SUBJECT = "(?:advisor|顾问)";

/**
 * Imperative verbs a user reaches for when asking for the advisor. Ordered
 * longest-first so `开一下` wins over a bare `开` and the diagnostic verb is the
 * one the user actually typed.
 */
const VERB = "(?:调用|使用|启用|开启|打开|开一下|用一下|让|请|找|叫)";

/** English imperative forms, since the tool name itself is English. */
const EN_VERB =
	"(?:call|use|enable|activate|invoke|consult|ask|bring in|turn on|switch on)";

/**
 * Negation window. Checked in the characters immediately preceding the matched
 * verb so "不要调用 advisor" and "别用 advisor" never grant access. Covers the
 * common Chinese and English negations; deliberately short so it stays local
 * and does not swallow an unrelated earlier clause.
 */
const NEGATION =
	/(?:不要|不用|不必|不需要|别|甭|勿|禁止|无需|不许|不准|没有必要|没必|不必|拒用|拒绝|千万不|先不|暂时不|不|勿需|没必要|don't|dont|do not|never|no need to|without|avoid|stop)$/i;

/**
 * Characters of lookbehind inspected for a negation. Sized for the longest
 * negator in NEGATION plus its separator — "please do not " (14) is the widest —
 * with slack. The test is anchored at the END of the window, so a wider window
 * only adds context; it cannot match a negation from an earlier clause.
 */
const NEGATION_WINDOW = 16;

/**
 * Chinese pattern: negation-free imperative verb immediately followed (within a
 * short gap) by the advisor subject. The gap allows "请 advisor 指导一下" and
 * "让 advisor 看看" but not a verb in one clause and `advisor` two clauses later.
 */
const ZH_PATTERN = new RegExp(
	`(${VERB})\\s*[，,、]?\\s*(?:一下\\s*)?${SUBJECT}`,
	"gi",
);

/** English pattern: `call the advisor`, `use advisor`, `ask advisor to ...`. */
const EN_PATTERN = new RegExp(
	`\\b(${EN_VERB})\\s+(?:the\\s+)?${SUBJECT}\\b`,
	"gi",
);

/**
 * Detect an explicit opt-in request in raw user input.
 *
 * Returns `{matched:false}` for questions ("advisor 是什么？"), complaints
 * ("advisor 太慢了"), retrospectives ("上次 advisor 说了什么"), and — critically —
 * negated imperatives ("不要调用 advisor"), so a user who forbids the tool in a
 * turn does not accidentally switch it on.
 */
export function detectOptInRequest(text: string): OptInMatch {
	if (!text) return { matched: false };

	for (const pattern of [ZH_PATTERN, EN_PATTERN]) {
		pattern.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = pattern.exec(text)) !== null) {
			const verb = m[1];
			const verbStart = m.index;
			// Trim trailing whitespace and separators first: "don't call" leaves the
			// window ending in a space, so an anchored negation test would miss it.
			const before = text
				.slice(Math.max(0, verbStart - NEGATION_WINDOW), verbStart)
				.replace(/[\s，,、：:]+$/u, "");
			if (NEGATION.test(before)) continue;
			return { matched: true, verb };
		}
	}

	return { matched: false };
}

/**
 * Session ids with an active grant. A Set (not a single id) because one process
 * can host several live sessions — workflow stages and forked sessions each get
 * their own id, and a grant in one must not leak into another.
 */
const optedIn = new Set<string>();

export function isSessionOptedIn(sessionId: string | undefined): boolean {
	if (!sessionId) return false;
	return optedIn.has(sessionId);
}

export function optInSession(sessionId: string | undefined): void {
	if (!sessionId) return;
	optedIn.add(sessionId);
}

/**
 * Drop a session's grant. Called on `session_start` so a resumed or forked
 * session under the same id cannot inherit a stale grant, and by `/advisor`
 * when the user selects "No advisor".
 */
export function resetSessionOptIn(sessionId: string | undefined): void {
	if (!sessionId) return;
	optedIn.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Persistence — a reload replaces the extension runtime, so the in-memory Set
// above cannot survive one. The grant is therefore ALSO recorded in the session
// itself via `pi.appendEntry`, and rebuilt on `session_start`.
//
// `CustomEntry` is the right vehicle: Pi documents it as "Persist extension
// state across session reloads. On reload, extensions can scan entries for
// their customType and reconstruct internal state", and it is explicitly
// ignored by `buildSessionContext` — so recording the grant never leaks into
// the model's context.
// ---------------------------------------------------------------------------

/** Entry tag for advisor grant records. Must stay stable across versions. */
export const OPTIN_ENTRY_TYPE = "advisor-optin";

interface OptInEntry {
	enabled: boolean;
}

/** Minimal shape of the session manager reads used here. */
interface SessionEntryReader {
	getBranch?: () => readonly unknown[];
	getEntries?: () => readonly unknown[];
}

/**
 * Rebuild a session's grant from its own entries.
 *
 * Scans newest-first and takes the LAST record: toggling on/off repeatedly must
 * resolve to the most recent intent, not the first one found. Forked sessions
 * inherit their parent's entries, so a fork of an opted-in session stays
 * opted in — that matches "fork duplicates the conversation".
 *
 * Returns `undefined` when the session has no record at all, which lets the
 * caller distinguish "explicitly off" from "never asked" (the latter falls back
 * to the configured default).
 */
export function restoreSessionOptIn(
	reader: SessionEntryReader | undefined,
	sessionId: string | undefined,
): boolean | undefined {
	if (!sessionId || !reader) return undefined;
	const entries = reader.getBranch?.() ?? reader.getEntries?.() ?? [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i] as { type?: string; customType?: string; data?: OptInEntry } | undefined;
		if (!e || e.type !== "custom" || e.customType !== OPTIN_ENTRY_TYPE) continue;
		const enabled = e.data?.enabled === true;
		if (enabled) optedIn.add(sessionId);
		else optedIn.delete(sessionId);
		return enabled;
	}
	return undefined;
}

/**
 * Record the grant for a session so a reload can rebuild it.
 *
 * The in-memory Set is updated unconditionally; the append is best-effort
 * because it needs a live session (`--no-session` runs have nowhere to write)
 * and losing persistence must not lose the grant for the current process.
 */
export function recordSessionOptIn(
	pi: { appendEntry?: (customType: string, data?: unknown) => void } | undefined,
	sessionId: string | undefined,
	enabled: boolean,
): void {
	if (!sessionId) return;
	if (enabled) optedIn.add(sessionId);
	else optedIn.delete(sessionId);
	try {
		pi?.appendEntry?.(OPTIN_ENTRY_TYPE, { enabled } satisfies OptInEntry);
	} catch {
		// No live session to persist into — the in-memory grant still stands.
	}
}

/** Test reset — clears every grant. */
export function __resetAllSessionOptIns(): void {
	optedIn.clear();
}
