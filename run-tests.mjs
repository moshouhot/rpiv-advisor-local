#!/usr/bin/env node
/**
 * Behaviour suite for the account-failover patch.
 *
 *   node ~/.pi/agent/local-plugins/rpiv-advisor-local/run-tests.mjs
 *
 * The suite must run OUTSIDE node_modules: Node refuses type-stripping there and
 * cannot resolve this package's `.js`-suffixed TypeScript imports (Pi loads them
 * through jiti, which does). So this stages a throwaway workspace, transpiles
 * with esbuild, retargets the specifiers, and runs node:test.
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";

const PKG = dirname(fileURLToPath(import.meta.url));

/**
 * Build under the OS temp dir, not beside the package.
 *
 * esbuild cannot resolve non-ASCII paths on Windows ("Could not resolve
 * C:/.../升级 测试/.../index.ts"), and this package may well live under one.
 * Every path esbuild touches is therefore staged into an ASCII-only directory
 * first; the hash keeps concurrent runs from different forks apart.
 */
const WORK = join(
	tmpdir(),
	`rpiv-advisor-tests-${createHash("sha256").update(PKG).digest("hex").slice(0, 10)}`,
);
const HOST_PI_AI = join(
	homedir(),
	"AppData", "Roaming", "npm", "node_modules",
	"@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai",
);
const HOST_CA = join(homedir(), "AppData", "Roaming", "npm", "node_modules", "@earendil-works", "pi-coding-agent");

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

/**
 * Recursive copy built from readdir + copyFileSync.
 *
 * Deliberately NOT `fs.cpSync`: on Node 24.13.0 / Windows it hard-crashes the
 * process (exit 0xC0000409, no output, no exception) when any path component is
 * non-ASCII. `existsSync`, `mkdirSync` and `copyFileSync` handle the same paths
 * fine, so rebuilding the recursion on those avoids the broken API and keeps the
 * suite runnable from directories like "D:\升级 测试".
 */
function copyTree(from, to) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		const src = join(from, entry.name);
		const dst = join(to, entry.name);
		if (entry.isDirectory()) copyTree(src, dst);
		else copyFileSync(src, dst);
	}
}

/** Locate the esbuild binary npm already cached for npx, else fall back to PATH. */
function findEsbuild() {
	const cache = join(homedir(), "AppData", "Local", "npm-cache", "_npx");
	if (existsSync(cache)) {
		for (const dir of readdirSync(cache)) {
			const exe = join(cache, dir, "node_modules", "@esbuild", "win32-x64", "esbuild.exe");
			if (existsSync(exe)) return exe;
		}
	}
	return "esbuild";
}

removeTree(WORK);
mkdirSync(WORK, { recursive: true });
copyTree(join(PKG, "advisor"), join(WORK, "advisor"));
copyTree(join(PKG, "prompts"), join(WORK, "prompts"));
copyTree(join(PKG, "test"), join(WORK, "test"));
// advisor/*.ts imports these as "../x.js".
for (const m of ["advisor-ui", "fuzzy"]) copyFileSync(join(PKG, `${m}.ts`), join(WORK, `${m}.ts`));

// Peer deps come from the HOST, never from this plugin's own node_modules.
const nm = join(WORK, "node_modules", "@earendil-works");
mkdirSync(nm, { recursive: true });
symlinkSync(HOST_PI_AI, join(nm, "pi-ai"), "junction");
symlinkSync(HOST_CA, join(nm, "pi-coding-agent"), "junction");
// advisor-ui.ts imports pi-tui for the picker components; the command module
// pulls it in transitively, so the suite needs it resolvable too.
const HOST_TUI = join(HOST_CA, "node_modules", "@earendil-works", "pi-tui");
if (existsSync(HOST_TUI)) symlinkSync(HOST_TUI, join(nm, "pi-tui"), "junction");
// `typebox` is a peer dependency, exactly as upstream declares it: Pi aliases the
// bare specifier to its own bundled copy at load time. Take the HOST's copy so the
// suite exercises the same instance the extension runs against. A plugin-local
// copy is only a fallback for hosts that do not bundle one.
const HOST_TYPEBOX = join(HOST_CA, "node_modules", "typebox");
const LOCAL_TYPEBOX = join(PKG, "node_modules", "typebox");
symlinkSync(existsSync(HOST_TYPEBOX) ? HOST_TYPEBOX : LOCAL_TYPEBOX, join(WORK, "node_modules", "typebox"), "junction");
// `@juicesharp/rpiv-config` ships TypeScript (`exports: "." -> ./index.ts") and
// Node refuses type-stripping under node_modules, so a symlink is not loadable
// here. Transpile the REAL package into the workspace instead of stubbing it —
// modelKey/parseModelKey behaviour is part of what these suites assert.
const RPIV_SRC = join(PKG, "node_modules", "@juicesharp", "rpiv-config");
// Copied, not referenced in place: the package may sit under a non-ASCII path
// that esbuild cannot resolve, so it must be reached through WORK.
const RPIV_ASCII_SRC = join(WORK, ".rpiv-config-src");
const RPIV_OUT = join(WORK, "node_modules", "@juicesharp", "rpiv-config");
mkdirSync(RPIV_OUT, { recursive: true });
writeFileSync(
	join(RPIV_OUT, "package.json"),
	JSON.stringify({ name: "@juicesharp/rpiv-config", type: "module", exports: { ".": "./index.mjs" } }),
);

const MODULES = [
	"command", "config", "context", "execute", "fallback", "handlers", "inventory",
	"lab-mode", "messages", "pi-compat", "policy", "prompt", "session-optin", "state",
];
/** Root-level modules (advisor/*.ts import them as "../x.js"). */
const ROOT_MODULES = ["advisor-ui", "fuzzy"];
const dist = join(WORK, "dist");
// Two invocations, not one: passing advisor/*.ts and the root modules together
// makes esbuild key the output on the common ancestor (work/), which would emit
// dist/advisor/*.mjs and break the flat layout the suites import from.
execFileSync(
	findEsbuild(),
	[...MODULES.map((m) => join(WORK, "advisor", `${m}.ts`)), "--format=esm", `--outdir=${dist}`, "--out-extension:.js=.mjs"],
	{ stdio: "inherit" },
);
execFileSync(
	findEsbuild(),
	[...ROOT_MODULES.map((m) => join(WORK, `${m}.ts`)), "--format=esm", `--outdir=${dist}`, "--out-extension:.js=.mjs"],
	{ stdio: "inherit" },
);

if (!existsSync(RPIV_SRC)) {
	// Fail loudly. Without it esbuild reports "Could not resolve ... index.ts",
	// which reads like a path bug rather than "node_modules was not installed".
	console.error(
		`✗ 缺少 ${RPIV_SRC}
` +
			"  运行测试前先执行: npm install --legacy-peer-deps",
	);
	process.exit(2);
}
copyTree(RPIV_SRC, RPIV_ASCII_SRC);
execFileSync(
	findEsbuild(),
	[
		join(RPIV_ASCII_SRC, "index.ts"),
		"--bundle",
		"--format=esm",
		"--platform=node",
		"--external:typebox",
		"--external:@earendil-works/*",
		`--outfile=${join(RPIV_OUT, "index.mjs")}`,
	],
	{ stdio: "inherit" },
);

// Transpiled modules import each other with .js specifiers; retarget to .mjs.
for (const f of readdirSync(dist).filter((f) => f.endsWith(".mjs"))) {
	const p = join(dist, f);
	// Normalise specifiers: every module lands flat in dist/. "./sibling.js"
	// becomes "./sibling.mjs"; "../root.js" (how advisor/*.ts imports the
	// root-level modules advisor-ui and fuzzy) collapses to "./root.mjs" because
	// both are peers in the flat output.
	const rewritten = readFileSync(p, "utf-8")
		.replace(/from "\.\.\/([A-Za-z-]+)\.js"/g, 'from "./$1.mjs"')
		.replace(/from "\.\/([A-Za-z-]+)\.js"/g, 'from "./$1.mjs"');
	writeFileSync(p, rewritten);
}

// prompt.ts reads ../prompts/advisor-system.txt relative to its own module.
copyTree(join(WORK, "prompts"), join(dist, "prompts"));

for (const suite of ["fallback.test.mjs", "session-optin.test.mjs"]) {
	execFileSync(process.execPath, ["--test", join(WORK, "test", suite)], { stdio: "inherit" });
}
