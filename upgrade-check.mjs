#!/usr/bin/env node
/**
 * upgrade-check.mjs — stage an upstream release, rebuild this fork on top of it,
 * and verify the STAGED candidate. Never touches the active plugin.
 *
 *   # same-version sanity check: rebuild from the frozen baseline
 *   node upgrade-check.mjs
 *
 *   # stage a new upstream release (unpacked package dir)
 *   node upgrade-check.mjs --from /c/upstream-stage/package --expect-version 2.14.0
 *
 *   # re-verify a stage left behind by an earlier run
 *   node upgrade-check.mjs --stage .upgrade-stage/2.14.0-20261018-1200
 *
 * Exit codes: 0 = candidate rebuilt and all checks passed
 *             1 = a check failed (assertions or tests) — see output
 *             2 = cannot build a candidate (missing patch, conflict, bad input)
 *             3 = environment problem (patch/rsync unavailable)
 *
 * Design rules (deliberate, do not "simplify" them away):
 *   - The active plugin directory is READ-ONLY here. Nothing is copied into it,
 *     and no global npm command is run. Staging happens under .upgrade-stage/.
 *   - `patch` is applied with -F0 (no fuzz). A hunk that does not match exactly is
 *     a conflict to be resolved by a human, not something to paper over.
 *   - Failures keep the stage on disk with .rej files so the conflict can be
 *     inspected. Success deletes it unless --keep is given.
 *   - Verification runs the STAGED copy's own scripts (they resolve paths from
 *     their own location), never the active fork's.
 *   - Child process exit codes are read from the child, never inferred from the
 *     exit code of a filter (grep/head/tail always "succeed").
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const PKG = dirname(fileURLToPath(import.meta.url));
const UPSTREAM_DIR = join(PKG, ".upstream");
const BASELINE = join(UPSTREAM_DIR, "baseline");
const PATCH = join(UPSTREAM_DIR, "personal.patch");
const MANIFEST = join(UPSTREAM_DIR, "MANIFEST.json");
const OVERRIDES = join(UPSTREAM_DIR, "package.overrides.json");
const STAGE_ROOT = join(PKG, ".upgrade-stage");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
	const i = args.indexOf(name);
	return i === -1 ? undefined : args[i + 1];
};

const wantKeep = flag("--keep");
const explicitStage = option("--stage");
const explicitFrom = option("--from");
const expectVersion = option("--expect-version");

/**
 * Remove a tree, unlinking symlinks/junctions explicitly.
 *
 * `fs.rmSync(..., { recursive: true })` reports success but leaves the whole
 * tree behind when the path is non-ASCII and contains junctions (observed on
 * Node 24.13.0 / Windows: the call returns, `existsSync` is still true). Doing
 * the walk by hand with `lstat` + `unlinkSync` is reliable, and unlinking a
 * junction never touches its target.
 */
function removeTree(target) {
	if (!existsSync(target)) return;
	for (const entry of readdirSync(target, { withFileTypes: true })) {
		const p = join(target, entry.name);
		if (entry.isSymbolicLink()) {
			unlinkSync(p);
		} else if (entry.isDirectory()) {
			removeTree(p);
		} else {
			unlinkSync(p);
		}
	}
	rmdirSync(target);
}

/** Paths that exist at the fork root but are not part of the fork's source. */
const TRANSIENT = new Set(["work", ".upgrade-stage", ".git", "node_modules"]);

/**
 * Every file present in the fork but absent from the frozen baseline.
 *
 * Excludes the two directories that hold the baseline itself and transient
 * build output, plus node_modules (reinstalled, never copied).
 */
function listForkOnly() {
	const out = [];
	const walk = (dir, prefix) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (!prefix && TRANSIENT.has(entry.name)) continue;
			if (!prefix && entry.name === ".upstream") continue;
			if (entry.isDirectory()) walk(join(dir, entry.name), rel);
			else if (!existsSync(join(BASELINE, rel))) out.push(rel);
		}
	};
	walk(PKG, "");
	return out.sort();
}

/** Recursive copy that skips install/build artifacts. */
function copyTree(from, to, skipTopLevel = []) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "work") continue;
		if (skipTopLevel.includes(entry.name)) continue;
		const src = join(from, entry.name);
		const dst = join(to, entry.name);
		if (entry.isDirectory()) copyTree(src, dst);
		else copyFileSync(src, dst);
	}
}

function mustExist(path, what) {
	if (!existsSync(path)) {
		console.error(`✗ 缺少${what}: ${path}`);
		process.exit(2);
	}
}

function run(label, cmd, argv, cwd) {
	process.stdout.write(`\n$ ${cmd} ${argv.join(" ")}\n   (cwd: ${cwd})\n`);
	try {
		execFileSync(cmd, argv, { cwd, stdio: "inherit" });
		console.log(`  ✓ ${label}`);
		return 0;
	} catch (err) {
		// `err.status` is the child's real exit code. Reading it is the whole
		// point: piping through grep/head would report grep's status instead.
		const code = typeof err.status === "number" ? err.status : 1;
		console.error(`  ✗ ${label} (exit ${code})`);
		return code || 1;
	}
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf-8"));
}

/** Rebuild package.json from the NEW upstream file plus the declarative overrides. */
function rebuildPackageJson(stage, upstreamVersion) {
	const overrides = readJson(OVERRIDES);
	const src = readJson(join(stage, "package.json"));
	const out = { ...src };

	for (const key of overrides.remove ?? []) delete out[key];
	Object.assign(out, overrides.set ?? {});
	out.version = `${upstreamVersion}${overrides.versionSuffix ?? ""}`;

	out.peerDependencies = { ...(src.peerDependencies ?? {}) };
	for (const [dep, range] of Object.entries(overrides.requirePeerDependencies ?? {})) {
		out.peerDependencies[dep] = range;
	}

	const problems = [];
	for (const dep of overrides.forbiddenDependencies ?? []) {
		if (out.dependencies?.[dep]) {
			problems.push(
				`宿主包 "${dep}" 出现在 dependencies —— 必须移到 peerDependencies，否则会产生第二份运行时实例`,
			);
		}
	}
	if (!out.peerDependencies.typebox) problems.push('peerDependencies 缺少 typebox:"*"');

	writeFileSync(join(stage, "package.json"), `${JSON.stringify(out, null, "\t")}\n`, "utf-8");
	return problems;
}

// ---------------------------------------------------------------------------
// 1. Resolve (or accept) a stage
// ---------------------------------------------------------------------------

let stage;
let upstreamVersion;
let sourceDir;

if (explicitStage) {
	stage = resolve(explicitStage);
	mustExist(join(stage, "package.json"), "stage 的 package.json");
	upstreamVersion = readJson(join(stage, "package.json")).version.replace(/-personal$/, "");
	console.log(`复用已有 stage: ${stage}`);
} else {
	sourceDir = explicitFrom ? resolve(explicitFrom) : BASELINE;
	mustExist(sourceDir, "上游源码目录");
	mustExist(PATCH, "personal.patch");
	mustExist(MANIFEST, "MANIFEST.json");

	upstreamVersion = readJson(join(sourceDir, "package.json")).version;
	if (expectVersion && upstreamVersion !== expectVersion) {
		console.error(`✗ 版本不符：--expect-version ${expectVersion}，但 ${sourceDir} 是 ${upstreamVersion}`);
		process.exit(2);
	}

	const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
	stage = join(STAGE_ROOT, `${upstreamVersion}-${stamp}`);
	removeTree(stage);

	console.log(`上游版本: ${upstreamVersion}`);
	console.log(`来源: ${sourceDir}`);
	console.log(`暂存: ${stage}`);

	// ---------------------------------------------------------------------------
	// 2. Lay down upstream, then apply the personal patch STRICTLY
	// ---------------------------------------------------------------------------
	copyTree(sourceDir, stage, [".upgrade-stage"]);

	const dry = run("补丁 dry-run (-F0, 无 fuzz)", "patch", ["-p1", "-F0", "--dry-run", "-i", PATCH], stage);
	if (dry !== 0) {
		console.error(
			`\n✗ 补丁与上游 ${upstreamVersion} 冲突。\n` +
				`  这是需要人工合并的情况，不是可以忽略的情况。\n` +
				`  stage 已保留: ${stage}\n` +
				`  下一步: 按 .upstream/MANIFEST.md 的 A 类清单逐个文件合并，\n` +
				`         合并完跑 node upgrade-check.mjs --stage "${stage}" 复验。`,
		);
		process.exit(2);
	}

	const applied = run("应用补丁", "patch", ["-p1", "-F0", "-i", PATCH], stage);
	if (applied !== 0) {
		console.error(`\n✗ 补丁应用失败，stage 保留: ${stage}`);
		process.exit(2);
	}

	// ---------------------------------------------------------------------------
	// 3. Fork-only files that no patch can create
	// ---------------------------------------------------------------------------
	// Derived from disk, not read from MANIFEST.json. The manifest is
	// documentation and drifts the moment a file is added; the authoritative
	// answer to "what does the fork have that upstream does not" is the
	// filesystem itself. MANIFEST.json is only cross-checked afterwards.
	const forkOnly = listForkOnly();
	if (forkOnly.length === 0) {
		console.error("✗ 无法推导 fork 独有文件 —— 清单不可信，停止");
		process.exit(2);
	}

	const recorded = readJson(MANIFEST).classification?.fork_only ?? [];
	const added = forkOnly.filter((f) => !recorded.includes(f));
	const removed = recorded.filter((f) => !forkOnly.includes(f) && f !== "package-lock.json");

	// Asymmetric on purpose. A file the manifest lists but the disk no longer has
	// means the fork lost something — that is a failure, not a stale document,
	// and deriving the list from disk would otherwise hide it completely.
	if (removed.length) {
		console.error(`
✗ 清单记录的文件在磁盘上不存在: ${removed.join(", ")}`);
		console.error("  这些文件属于 fork 独有资产，缺失会静默丢功能。恢复后再升级。");
		process.exit(2);
	}
	// The other direction only means the manifest needs updating.
	if (added.length) {
		console.warn(`
⚠ MANIFEST.json 少记了这些文件（不影响本次构建，请补进清单）: ${added.join(", ")}`);
	}
	for (const rel of forkOnly) {
		if (rel === "package-lock.json") continue; // regenerated by npm install, never copied
		const src = join(PKG, rel);
		if (!existsSync(src)) {
			console.error(`✗ fork 独有文件缺失: ${rel}（清单与磁盘不一致）`);
			process.exit(2);
		}
		mkdirSync(dirname(join(stage, rel)), { recursive: true });
		copyFileSync(src, join(stage, rel));
	}
	console.log(`\n✓ 已带入 fork 独有文件 ${forkOnly.length - 1} 个（package-lock 由 npm 生成）`);

	// ---------------------------------------------------------------------------
	// 4. package.json by rule, not by copy
	// ---------------------------------------------------------------------------
	const problems = rebuildPackageJson(stage, upstreamVersion);
	if (problems.length > 0) {
		console.error("\n✗ package.json 不符合 fork 约束：");
		for (const p of problems) console.error(`   - ${p}`);
		console.error(`\n  已按规则写入 stage 的 package.json，但依赖结构仍需人工确认。stage: ${stage}`);
		process.exit(2);
	}
	console.log("✓ package.json 已按 .upstream/package.overrides.json 重建");

	// The peer dependency the test harness needs to resolve.
	const hostConfig = join(PKG, "node_modules", "@juicesharp", "rpiv-config");
	if (existsSync(hostConfig)) {
		mkdirSync(join(stage, "node_modules", "@juicesharp"), { recursive: true });
		symlinkSync(hostConfig, join(stage, "node_modules", "@juicesharp", "rpiv-config"), "junction");
	}
}

// ---------------------------------------------------------------------------
// 5. Verify the STAGED candidate — its own scripts, its own files
// ---------------------------------------------------------------------------

const results = [];
results.push(["静态断言 check-upstream-merge.mjs", run("静态断言", process.execPath, [join(stage, "check-upstream-merge.mjs")], stage)]);
results.push(["行为测试 run-tests.mjs", run("行为测试", process.execPath, [join(stage, "run-tests.mjs")], stage)]);

process.stdout.write("\n================ 结论 ================\n");
for (const [label, code] of results) {
	process.stdout.write(`${code === 0 ? "  PASS" : "  FAIL"}  ${label}${code ? `  (exit ${code})` : ""}\n`);
}
const failed = results.filter(([, code]) => code !== 0).length;

if (failed === 0) {
	if (!wantKeep) {
		removeTree(stage);
		process.stdout.write("\n候选通过。stage 已清理（--keep 可保留）。\n");
	} else {
		process.stdout.write(`\n候选通过。stage 保留: ${stage}\n`);
	}
	process.stdout.write(
		"\n提醒：静态断言只证明关键代码点在位，不证明功能完整。\n" +
			"      切换到候选前请确认 UPGRADING.md 的人工步骤（真实端到端）已完成。\n",
	);
	process.exit(0);
}

process.stderr.write(`\n✗ ${failed} 项失败。stage 保留供排查: ${stage}\n`);
process.exit(1);
