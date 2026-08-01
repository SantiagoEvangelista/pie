/** Shared child-model routing policy for subagents and workflow agents. */
export const DELEGATED_MODEL_TIERING_GUIDELINES = [
  "Classify each delegated task by required intelligence before choosing its model; do not inherit the expensive orchestrator accidentally. Explicitly pass the model matching the selected tier.",
  "Bounded execution tier — GPT-5.6 Terra (`openai-codex/gpt-5.6-terra`): focused discovery, extraction, inventories, straightforward tests, narrow reviews, and simple isolated changes with clear acceptance criteria. Prefer low or medium effort.",
  "Advanced reasoning tier — GPT-5.6 Sol (`openai-codex/gpt-5.6-sol`): high-complexity, ambiguous, long-running, or multi-step work such as architecture, difficult debugging, broad implementation, security-critical review, and synthesis across agent outputs. Prefer high or xhigh effort.",
  "Disallowed tier — GPT-5.6 Luna: do not use it for delegated work. Choose the lowest tier that safely fits the task; if bounded-tier work exposes hidden complexity or fails for capability reasons, escalate only that task to Sol rather than rerunning the whole workflow at the higher tier.",
  "Model syntax differs by tool: subagent_spawn uses `model: \"openai-codex/<model-id>\"`; workflow agent() uses `provider: \"openai-codex\", model: \"<model-id>\"`.",
] as const;
