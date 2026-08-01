import { isUltracodeThinkingLevel } from "../shared/thinking-level.ts";

/** Standing orchestration policy injected only while ultracode is selected. */
export const ULTRACODE_SYSTEM_INSTRUCTION = [
  "Ultracode mode is active.",
  "Use workflow as the default execution path for nontrivial tasks; do not wait for the user to request orchestration explicitly.",
  "Prefer phased fan-out for independent investigation or implementation, then verification and synthesis.",
  "Keep trivial, single-step tasks in the main session, and avoid fan-out that adds no useful parallelism or independent checking.",
].join("\n");

export function ultracodeSystemPrompt(
  systemPrompt: string,
  thinkingLevel: unknown,
): string | undefined {
  if (!isUltracodeThinkingLevel(thinkingLevel)) return undefined;
  return `${systemPrompt}\n\n${ULTRACODE_SYSTEM_INSTRUCTION}`;
}
