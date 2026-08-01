import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  collectRuntimeContext,
  injectRuntimeContext,
  renderRuntimeContext,
} from "./runtime-context.ts";

const BEHAVIOR_PROMPT_BEGIN = "<!-- CLAUDE_BEHAVIOR_PROMPT_BEGIN -->";
const BEHAVIOR_PROMPT_END = "<!-- CLAUDE_BEHAVIOR_PROMPT_END -->";
const behaviorPrompt = readFileSync(
  new URL("./prompt.md", import.meta.url),
  "utf8",
).trim();

export function appendBehaviorPrompt(systemPrompt: string): string {
  return [
    systemPrompt.trimEnd(),
    "",
    BEHAVIOR_PROMPT_BEGIN,
    behaviorPrompt,
    BEHAVIOR_PROMPT_END,
  ].join("\n");
}

export default function claudeSystemPromptExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const values = await collectRuntimeContext(
      event,
      ctx,
      String(pi.getThinkingLevel()),
    );
    const withBehavior = appendBehaviorPrompt(event.systemPrompt);

    return {
      systemPrompt: injectRuntimeContext(
        withBehavior,
        renderRuntimeContext(values),
      ),
    };
  });
}
