# rpiv-advisor-local

**Unofficial local fork of [`@juicesharp/rpiv-advisor`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor).**

Not affiliated with, endorsed by, or maintained by the upstream author.
All upstream credit belongs to [juicesharp](https://github.com/juicesharp);
this repository only adds a personal patch set on top of 2.13.8.

> Upstream is the right choice for almost everyone:
> `pi install npm:@juicesharp/rpiv-advisor`

---

## What this fork adds

### 1. Cross-account retry for the advisor call

The advisor's completion call uses pi-ai's `completeSimple()` directly, bypassing
Pi's agent loop. It therefore emits no `message_end` / `assistant_error` events,
so account-rotation extensions are blind to advisor failures: one exhausted
account takes the advisor down while healthy siblings sit idle.

This fork retries the **same model id** on sibling accounts of the same family
(provider name minus the `-account-<N>` suffix). It never changes the model —
only which credentials answer it.

The classifier is deliberately narrow: it matches quota/credential exhaustion
(`insufficient_quota`, `usage limit`, `401/403`), and explicitly excludes
service-side failures such as `503` / `overloaded`, which should surface as-is
rather than burn through every sibling account.

### 2. Per-session opt-in

The advisor is **off by default** in every session. It activates only when you
ask for it in that session:

| Input | Effect |
|---|---|
| `call the advisor` / `ask advisor to review this` / 调用 advisor | enables this session |
| `don't call the advisor` / 别用 advisor | stays off (negation-aware) |
| `what does the advisor do?` / 上次 advisor 说了什么 | stays off (not imperative) |
| `/advisor on` / `/advisor off` | session toggle |
| `/advisor always on` / `always off` | default for future sessions |
| new session / process restart | follows the recorded default |
| `/reload` | authorization survives (written to the session ledger) |

Rationale: an advisor call ships the entire conversation (~130K tokens) to a
second, external model. Making that a per-session explicit act rather than a
standing default is a deliberate privacy/cost boundary.

### 3. Hard block in "lab" environments

When `~/.pi/agent/lab-mode.flag` exists, the advisor is unavailable regardless of
authorization. The gate **suspends** rather than revokes: leaving lab mode
restores the previous state, and `/advisor always on` still works across a lab
session.

---

## Status and scope

Version `2.13.8-personal`, based on upstream `2.13.8`.

Verified on the committed tree: 43 static assertions, 55 behavioural tests
(24 failover + 31 opt-in/lab), and a same-version rebuild that reproduces the
plugin tree byte-for-byte from the frozen baseline.

**This is a personal fork, maintained for one setup.** It is published because
the upgrade machinery may be useful to others, not as a supported distribution.
The opt-in default and lab gate are opinions about how *my* sessions should
behave; they are not claims about what upstream ought to do, and this fork does
not send changes upstream.

---

## Layout

| Path | Contents |
|---|---|
| `advisor/` | Fork source. `fallback.ts`, `session-optin.ts`, `lab-mode.ts` are fork-only |
| `.upstream/baseline/` | Complete upstream 2.13.8 package (23 files) — the diff base |
| `.upstream/personal.patch` | Every local change: 9 files, 952 lines |
| `.upstream/MANIFEST.md` `.json` | File classification and per-file sha256 |
| `AGENTS.md` | Hard constraints for AI-assisted work on this repo |
| `UPGRADING.md` | Mechanical procedure for rebasing onto a new upstream |
| `upgrade-check.mjs` | Stages a candidate and verifies it without touching the live plugin |
| `PERSONAL_MAINTENANCE.md` | Design rationale and change specifications |

### Why the upgrade assets are the interesting part

Rebasing a 500-line local patch by hand onto a moving upstream fails quietly.
Instead, every local change is frozen into `.upstream/personal.patch`, applied
with `patch -p1 -F0` (no fuzz), and verified in a throwaway stage:

```sh
node upgrade-check.mjs --from <unpacked-upstream> --expect-version <version>
```

Exit codes: `0` pass / `1` check failed / `2` cannot build (patch conflict,
missing asset) / `3` environment. On conflict the stage is kept with `.rej`
files, so only the failing hunks need human attention.

`package.json` deliberately stays out of the patch: its version and dependency
ranges churn every release, so a byte-level patch would conflict every time.
It is regenerated from `.upstream/package.overrides.json` instead.

---

## Notes for anyone reusing this

- The fork-only files (`advisor/fallback.ts`, `advisor/session-optin.ts`,
  `advisor/lab-mode.ts`) do not exist upstream, so `cp *.ts` over this tree will
  not clobber them — but `cp` of the nine *patched* files will silently drop the
  local functionality. `AGENTS.md` lists them.
- `~/.pi/agent/settings.json` package entries must be plain strings
  (`"./local-plugins/rpiv-advisor-local"`). The object form with an empty
  `extensions` array is a filter that matches nothing and silently disables the
  entire package.
- Two Node/Windows quirks are worked around in the scripts and should stay that
  way: `fs.cpSync` crashes the process on non-ASCII paths, and
  `fs.rmSync(recursive)` reports success while leaving the tree behind.

---

## License

MIT, same as upstream. See [`LICENSE`](LICENSE) — copyright for the original
work belongs to juicesharp; this fork's changes carry no additional restrictions.
