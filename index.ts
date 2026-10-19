/**
 * rpiv-advisor — Pi extension
 *
 * Registers the `advisor` tool, `/advisor` command, and five lifecycle
 * hooks (session_start restore, input opt-in gate, before_agent_start strip,
 * model_select re-evaluation, thinking_level_select re-evaluation) that
 * together implement the advisor-strategy pattern.
 *
 * The advisor is OFF by default in every session. It activates only after the
 * user explicitly asks for it in that session ("调用 advisor", "请 advisor
 * 指导一下"), or after running `/advisor` to pick a model. The grant is scoped
 * to the session id and never persists to disk.
 *
 * Config persists at ~/.config/rpiv-advisor/advisor.json. Tool name
 * preserved verbatim from rpiv-pi@7525a5d.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	registerAdvisorBeforeAgentStart,
	registerAdvisorCommand,
	registerAdvisorSessionStart,
	registerAdvisorTool,
	registerInputOptInHandler,
	registerModelSelectHandler,
	registerThinkingLevelSelectHandler,
} from "./advisor/index.js";

export default function (pi: ExtensionAPI) {
	registerAdvisorTool(pi);
	registerAdvisorCommand(pi);
	// Input gate first: it must be able to grant the session before the
	// before_agent_start handler reads the grant for the same turn.
	registerInputOptInHandler(pi);
	registerAdvisorBeforeAgentStart(pi);
	registerModelSelectHandler(pi);
	registerThinkingLevelSelectHandler(pi);
	registerAdvisorSessionStart(pi);
}
