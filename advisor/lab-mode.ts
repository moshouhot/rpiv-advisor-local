/**
 * lab-mode — reads the shared lab-mode flag.
 *
 * The advisor is never allowed to take part in lab work: the lab environment is
 * the reverse-engineering workspace, and every advisor call ships the whole
 * conversation branch (≈130K tokens) to a third-party model. Keeping the
 * reviewer out of that path is a scope decision, not a capability one, so it is
 * enforced here rather than left to the executor's judgement.
 *
 * The flag file is owned by `~/.pi/agent/extensions/security-audit-interceptor.ts`
 * (written on `lab：`, removed on `退出实验`). Both sides must agree on the path;
 * it is duplicated rather than imported because the two files are separate Pi
 * extensions loaded independently, and a cross-extension import would create a
 * load-order dependency that `/reload` can break.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Must match LAB_FLAG_PATH in security-audit-interceptor.ts. */
export const LAB_MODE_FLAG_PATH = join(homedir(), ".pi", "agent", "lab-mode.flag");

/**
 * Test override. `undefined` means "read the real flag"; a boolean pins the
 * answer so the suite never has to create or delete the user's actual flag file.
 */
let override: boolean | undefined;

/**
 * True while the lab environment is active.
 *
 * Read on every call (no caching): the flag is toggled mid-process by a chat
 * command, so a value cached at load would be wrong for the rest of the session.
 */
export function isLabModeActive(): boolean {
	if (override !== undefined) return override;
	try {
		return existsSync(LAB_MODE_FLAG_PATH);
	} catch {
		// An unreadable path means "cannot prove lab is off" — but treating that as
		// "lab is on" would disable the advisor permanently on an odd filesystem.
		return false;
	}
}

/** Test hook — pass `undefined` to fall back to the real flag file. */
export function __setLabModeOverride(value: boolean | undefined): void {
	override = value;
}
