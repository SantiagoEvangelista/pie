import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DISABLED_TOOLS = new Set(["edit", "write"]);

function disableFileWriteTools(pi: ExtensionAPI): void {
	const activeTools = pi.getActiveTools();
	const allowedTools = activeTools.filter((name) => !DISABLED_TOOLS.has(name));

	if (allowedTools.length !== activeTools.length) {
		pi.setActiveTools(allowedTools);
	}
}

export default function disableFileWriteToolsExtension(pi: ExtensionAPI): void {
	pi.on("session_start", () => disableFileWriteTools(pi));
	pi.on("model_select", () => disableFileWriteTools(pi));
	pi.on("before_agent_start", () => disableFileWriteTools(pi));
	pi.on("turn_start", () => disableFileWriteTools(pi));

	pi.on("tool_call", (event) => {
		if (DISABLED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Tool '${event.toolName}' is disabled; use apply_patch for file changes.`,
			};
		}
	});
}
