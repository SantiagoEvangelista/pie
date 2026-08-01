/** Shared child-model routing policy for subagents and workflow agents. */
export const DELEGATED_MODEL_TIERING_GUIDELINES = [
  "Classify each delegated task by required intelligence before choosing its model; do not inherit the expensive orchestrator accidentally. Explicitly pass the model matching the selected tier.",
  "Bounded execution tier — GPT-5.6 Sol (`openai-codex/gpt-5.6-sol`) at medium effort: focused discovery, extraction, inventories, straightforward tests, narrow reviews, and simple isolated changes with clear acceptance criteria.",
  "Advanced reasoning tier — GPT-5.6 Sol (`openai-codex/gpt-5.6-sol`) at high effort: high-complexity, ambiguous, long-running, or multi-step work such as architecture, difficult debugging, broad implementation, security-critical review, and synthesis across agent outputs.",
  "Disallowed tier — GPT-5.6 Luna: do not use it for delegated work. Choose medium effort for bounded tasks and high effort for advanced tasks; escalate only the specific task whose complexity requires it.",
  "Model syntax differs by tool: subagent_spawn uses `model: \"openai-codex/<model-id>\"`; workflow agent() uses `provider: \"openai-codex\", model: \"<model-id>\"`.",
] as const;

/** Default delegated effort by model tier; preserve inheritance for other models. */
export function defaultDelegatedReasoningEffort(
  modelId: string | undefined,
  inherited: string,
): string {
  if (modelId === "gpt-5.6-sol") return "medium";
  return inherited;
}
