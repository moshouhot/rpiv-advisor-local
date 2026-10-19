#!/usr/bin/env node
/**
 * check-upstream-merge.mjs — 升级后自校验：确认上游修复没有在「手工重做补丁」时被丢掉。
 *
 *   node ~/.pi/agent/local-plugins/rpiv-advisor-local/check-upstream-merge.mjs
 *
 * 为什么需要它：
 *   本 fork 的 execute.ts 是「上游版本 + failover 补丁」手工合并的产物。每次上游发新版，
 *   都要在新版 execute.ts 上重做补丁 —— 而重做时最容易漏掉的，恰恰是「上游这一版新加的
 *   那几行」。2026-10-17 的 2.10.1 -> 2.13.8 升级就差一点漏掉 #295 的 stripToolDeclarations。
 *
 *   本脚本不复述数字，而是直接检查「上游 2.13.8 里存在的关键调用，在我们的 fork 里是否仍在」。
 *   上游版本号变了就新增一组断言，旧组保留（它们是回归防线，不是一次性检查）。
 *
 * 退出码：0 = 全部关键点仍在；1 = 有丢失（不要发布这个 fork）。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = dirname(fileURLToPath(import.meta.url));
const EXECUTE = join(PKG, "advisor", "execute.ts");
const CONTEXT = join(PKG, "advisor", "context.ts");
const INDEX = join(PKG, "advisor", "index.ts");
const SYSTEM_PROMPT = join(PKG, "prompts", "advisor-system.txt");
const HANDLERS = join(PKG, "advisor", "handlers.ts");
const OPTIN = join(PKG, "advisor", "session-optin.ts");
const LAB = join(PKG, "advisor", "lab-mode.ts");
const COMMAND = join(PKG, "advisor", "command.ts");
const CONFIG = join(PKG, "advisor", "config.ts");
const RESTORE = join(PKG, "advisor", "restore.ts");
const ROOT_INDEX = join(PKG, "index.ts");

/** 每组 = 某个上游版本引入的必须保留的关键点。 */
const UPSTREAM_INVARIANTS = [
	{
		version: "2.13.8",
		why: "#295 — Pi >= 1.0 把工具声明写进 transcript 的 system 消息；只传 tools: [] 不够，advisor 会以 toolUse 无文本终止",
		checks: [
			{ file: CONTEXT, needle: "export function stripToolDeclarations", what: "context.ts 定义 stripToolDeclarations" },
			{ file: INDEX, needle: "stripToolDeclarations", what: "index.ts 转导出 stripToolDeclarations" },
			{ file: EXECUTE, needle: "stripInflightAdvisorCall(stripToolDeclarations(convertToLlm(sessionMessages)))", what: "execute.ts 管线按 脱 toolCall -> 脱工具声明 -> 保 user 尾 的顺序串联" },
		],
	},
];

/** 本 fork 独有、任何升级都不得丢失的设计约束。 */
const FORK_INVARIANTS = [
	{ file: EXECUTE, needle: 'from "./fallback.js"', what: "execute.ts 引入 fallback 模块" },
	{ file: EXECUTE, needle: "buildAdvisorCandidates(available, advisor)", what: "候选链由 buildAdvisorCandidates 生成" },
	{ file: EXECUTE, needle: "getApiKeyAndHeaders(candidate)", what: "★ 凭据按候选逐个解析（提到循环外会假装换账号）" },
	{ file: EXECUTE, needle: "isRetryableAdvisorError(message)", what: "抛出的异常也过同一个窄分类器" },
	{ file: EXECUTE, needle: "for (const candidate of candidates)", what: "存在候选链循环" },
	{ file: EXECUTE, needle: "signal?.aborted", what: "每次尝试前重查 abort" },
	{ file: EXECUTE, needle: "errAllCandidatesFailed(failures)", what: "全链失败时聚合" },
	// prompts/advisor-system.txt 是本 fork 的第二个偏离点。上游版本没有这些条款，
	// 而 `cp prompts/*` 会静默覆盖掉它们 —— 所以必须断言。
	{ file: SYSTEM_PROMPT, needle: "Do not invent unseen facts", what: "★ 人设：防幻觉条款仍在（上游原版没有）" },
	{ file: SYSTEM_PROMPT, needle: "never the filesystem", what: "★ 人设：明确它看不到磁盘" },
	{ file: SYSTEM_PROMPT, needle: "The parent owns execution, verification, and user communication", what: "★ 人设：权责边界条款仍在" },
	{ file: SYSTEM_PROMPT, needle: "scope, authorization, significant cost, or irreversible consequences", what: "★ 人设：停止信号门槛已具体化" },
	// per-session opt-in gate: the advisor is OFF until the user asks for it.
	// Losing any of these silently restores "always on", which is the behaviour
	// this fork deliberately removed.
	{ file: OPTIN, needle: "export function detectOptInRequest", what: "★ opt-in：关键词检测函数存在" },
	{ file: OPTIN, needle: "NEGATION", what: "★ opt-in：否定检测（否则“不要调用 advisor”会启用它）" },
	{ file: OPTIN, needle: "const optedIn = new Set<string>()", what: "★ opt-in：授权按 session id 存储，不是全局开关" },
	{ file: HANDLERS, needle: "opts.blocked || !isSessionOptedIn(sessionId)", what: "★ opt-in：reconcile 里 AND 进会话授权门" },
	{ file: HANDLERS, needle: 'pi.on("input"', what: "★ opt-in：input hook 存在（同轮生效）" },
	{ file: HANDLERS, needle: 'action: "continue"', what: "★ opt-in：不改写用户输入" },
	{ file: RESTORE, needle: "resetSessionOptIn(sessionId)", what: "★ opt-in：session_start 时重置（新会话回到关闭）" },
	{ file: ROOT_INDEX, needle: "registerInputOptInHandler(pi)", what: "★ opt-in：根 index 注册了 input hook" },
	// lab mode is an absolute prohibition on the advisor, and it must win over a
	// grant the session already holds. Dropping the AND lets a lab session that
	// said "调用 advisor" earlier keep the tool.
	{ file: LAB, needle: "lab-mode.flag", what: "★ lab：读取与 interceptor 共享的标志文件" },
	{ file: HANDLERS, needle: "opts.blocked || !isSessionOptedIn(sessionId) || isLabModeActive()", what: "★ lab：reconcile 里 AND 进 lab 禁令" },
	// Lab SUSPENDS, it must not revoke: a persisted false record outranks the
	// configured default, so "always on" would never recover after leaving lab.
	{ file: HANDLERS, forbiddenNeedle: "recordSessionOptIn(pi, sessionId, false)", what: "★ lab：handlers 不得持久化撤销（只暂停，不吊销）" },
	{ file: RESTORE, forbiddenNeedle: "recordSessionOptIn(pi, sessionId, false)", what: "★ lab：restore 不得持久化撤销（只暂停，不吊销）" },
	{ file: COMMAND, needle: "recordSessionOptIn(pi, sessionId, false)", what: "★ 显式 off 仍然要落盘（与 lab 暂停区分开）" },
	{ file: HANDLERS, needle: "MSG_ADVISOR_LAB_BLOCKED", what: "★ lab：input/命令路径明确拒绝而非静默剥离" },
	{ file: RESTORE, needle: "isLabModeActive()", what: "★ lab：session_start 不再提示“说关键词即可启用”" },
	// `/advisor on|off` — the command-line counterpart of the opt-in keyword.
	{ file: COMMAND, needle: 'getArgumentCompletions', what: "★ on/off：命令带参数补全" },
	{ file: COMMAND, needle: 'sub === "on" || sub === "off"', what: "★ on/off：在交互门之前解析，非交互宿主也能用" },
	{ file: COMMAND, needle: "function applySessionOff", what: "★ on/off：off 只撤会话授权，不清持久模型" },
	{ file: COMMAND, needle: "function applySessionOn", what: "★ on/off：on 走 reconcile，受 lab 与执行器黑名单约束" },
	// Grant persistence across /reload. Reload replaces the extension runtime, so
	// a memory-only grant is guaranteed to vanish; these carry the real check.
	{ file: OPTIN, needle: 'export const OPTIN_ENTRY_TYPE = "advisor-optin"', what: "★ 持久化：session 条目类型固定" },
	{ file: OPTIN, needle: "export function recordSessionOptIn", what: "★ 持久化：授权写入 session" },
	{ file: OPTIN, needle: "export function restoreSessionOptIn", what: "★ 持久化：reload 后从 session 重建" },
	{ file: OPTIN, needle: "for (let i = entries.length - 1; i >= 0; i--)", what: "★ 持久化：倒序取最后一条（最新意图）" },
	{ file: RESTORE, needle: "restoreSessionOptIn(ctx?.sessionManager", what: "★ 持久化：session_start 走重建而非无脑清空" },
	{ file: CONFIG, needle: "defaultEnabled?: boolean", what: "★ always：跨会话默认授权" },
	{ file: COMMAND, needle: "function applyAlways", what: "★ always：always on/off 子命令" },
	{ file: RESTORE, needle: "config.defaultEnabled", what: "★ always：无会话记录时按默认授权" },
];

/**
 * 判定顺序必须是 aborted -> error -> 空响应。
 * 顺序错了会把无文本的配额错误误判成空响应，在同账号重试并丢掉可操作信息。
 */
function checkOrder() {
	const src = readFileSync(EXECUTE, "utf-8");
	const iAbort = src.indexOf('if (response.stopReason === "aborted")');
	const iError = src.indexOf('if (response.stopReason === "error")');
	// R6.4 空响应重试：第一次出现在 error 判定之后的 `if (!advisorText)`
	const iEmpty = src.indexOf("if (!advisorText)");
	if (iAbort < 0 || iError < 0 || iEmpty < 0) {
		return { ok: false, what: "无法定位 aborted/error/empty 三处判定" };
	}
	if (!(iAbort < iError && iError < iEmpty)) {
		return {
			ok: false,
			what: `判定顺序错误：aborted@${iAbort} error@${iError} empty@${iEmpty} —— 必须是 aborted -> error -> empty`,
		};
	}
	return { ok: true, what: "判定顺序 aborted -> error -> empty 正确" };
}

/** fallback.ts 的分类器必须窄：503 是服务故障，换账号无用。 */
function checkClassifierNarrowness() {
	const src = readFileSync(join(PKG, "advisor", "fallback.ts"), "utf-8");
	// 裸词 capacity / billing / insufficient / expired 不得作为独立模式出现
	const banned = [/\n\s*\/capacity\/i,/, /\n\s*\/billing\/i,/, /\n\s*\/insufficient\/i,/, /\n\s*\/expired\/i,/];
	const hit = banned.find((re) => re.test(src));
	if (hit) return { ok: false, what: `分类器出现过宽的裸词模式：${hit}` };
	// 503 不得被当作可重试
	if (/\/503\//.test(src)) return { ok: false, what: "分类器把 503 当成可重试（服务故障换账号无用）" };
	return { ok: true, what: "分类器保持窄口径（无裸词，且排除 503）" };
}

const results = [];
function run(label, checks) {
	for (const c of checks) {
		if (!existsSync(c.file)) {
			results.push({ ok: false, label, what: `${c.what} — 文件不存在 ${c.file}` });
			continue;
		}
		const src = readFileSync(c.file, "utf-8");

		// `forbiddenNeedle` asserts something must NOT be there. Needed because
		// "we no longer do X" is not expressible with presence checks, and a
		// silently reintroduced X is exactly the regression that matters.
		if (c.forbiddenNeedle) {
			const hit = src.includes(c.forbiddenNeedle);
			results.push({
				ok: !hit,
				label,
				what: hit
					? `${c.what} — 出现了禁止的写法: ${JSON.stringify(c.forbiddenNeedle.slice(0, 70))}`
					: c.what,
			});
			continue;
		}

		const ok = src.includes(c.needle);
		results.push({ ok, label, what: ok ? c.what : `${c.what} — 缺失: ${JSON.stringify(c.needle.slice(0, 70))}` });
	}
}

run("上游", UPSTREAM_INVARIANTS.flatMap((g) => g.checks.map((c) => ({ ...c, _v: g.version }))));
run("fork", FORK_INVARIANTS);

const order = checkOrder();
results.push({ ok: order.ok, label: "fork", what: order.what });
const narrow = checkClassifierNarrowness();
results.push({ ok: narrow.ok, label: "fork", what: narrow.what });

let failed = 0;
for (const r of results) {
	const tag = r.ok ? "  OK  " : " FAIL ";
	if (!r.ok) failed++;
	console.log(`${tag} [${r.label}] ${r.what}`);
}

console.log("");
if (failed === 0) {
	console.log(`PASS — ${results.length} 项检查全部通过。`);
	process.exit(0);
}
console.log(`FAIL — ${failed}/${results.length} 项未通过。不要发布这个 fork。`);
process.exit(1);
