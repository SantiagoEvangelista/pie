/** Runtime defaults shared by direct subagents and workflow agents. */
export const DEFAULT_DELEGATED_PROVIDER = "openai-codex";
export const DEFAULT_DELEGATED_MODEL_ID = "gpt-5.6-sol";
export const DEFAULT_DELEGATED_REASONING_EFFORT = "medium";
export const ADVANCED_DELEGATED_PROVIDER = "openai-codex";
export const ADVANCED_DELEGATED_MODEL_ID = "gpt-5.6-sol";
export const ADVANCED_DELEGATED_REASONING_EFFORT = "high";
export const ORCHESTRATOR_MODEL_ID = "gpt-5.6-sol";

/** Shared child-model routing policy for subagents and workflow agents. */
export const DELEGATED_MODEL_TIERING_GUIDELINES = [
  "Keep GPT-5.6 Sol (`openai-codex/gpt-5.6-sol`) as the highest-capability parent orchestrator: it owns task framing, decomposition, tradeoffs, cross-agent adjudication, integration decisions, and the final answer. Do not delegate generic orchestration or final synthesis.",
  "Worker tier — GPT-5.6 Sol (`openai-codex/gpt-5.6-sol`) at medium effort: codebase inspection, focused research, extraction, inventories, implementation, targeted refactors, routine debugging, builds/tests, and narrow review. This is the default delegated tier.",
  "Advanced tier — GPT-5.6 Sol (`openai-codex/gpt-5.6-sol`) at high effort: genuinely ambiguous or cross-cutting architecture, difficult root-cause analysis, deep domain/math reasoning, security-critical analysis, and deep high-stakes adversarial review. Escalate only tasks needing deeper judgment; return evidence to the parent rather than replacing it.",
  "Omitted child model/effort defaults to GPT-5.6 Sol/medium. Select the same model with high effort explicitly for advanced work. Keep ultracode and final orchestration in the parent.",
  "Before every child call, the parent must reduce the assignment to one mechanical or independently verifiable purpose. Never delegate a compound inspect-plus-design-plus-implement-plus-test role; split those stages into separate calls or later batches.",
  "Use more, narrower agents for nontrivial work: prefer 3-4 orthogonal worker tasks in an initial batch and at least 2 independent verification or critique tasks after changes when scope supports them. If one prompt spans multiple independent files, questions, or deliverables, split it again. Use later batches rather than widening prompts; do not add filler agents.",
  "Give each child exact inputs, one owned file or tightly coupled file set, one question or change, one concrete deliverable, acceptance criteria, and an explicit stop condition. Tell it what not to inspect or change. Forbid adjacent exploration, open-ended discovery, overlapping whole-repo scans, duplicate implementations, and generic requests to understand or fix an entire subsystem.",
  "Parallel edits require disjoint ownership. Give shared files or integration surfaces one writer; parent adjudicates conflicts and reviews every child result.",
  "Model syntax differs by tool: subagent_spawn uses `model: \"<provider>/<model-id>\"`; workflow agent() uses separate `provider` and `model` values.",
] as const;

function usesDelegatedSolTier(
  provider: string | undefined,
  modelId: string | undefined,
): boolean {
  return (
    provider === DEFAULT_DELEGATED_PROVIDER &&
    modelId === DEFAULT_DELEGATED_MODEL_ID
  );
}

/** Sol children use only the configured worker and advanced effort tiers. */
export function isDelegatedReasoningEffortAllowed(
  provider: string | undefined,
  modelId: string | undefined,
  effort: string,
): boolean {
  if (!usesDelegatedSolTier(provider, modelId)) return true;
  return (
    effort === DEFAULT_DELEGATED_REASONING_EFFORT ||
    effort === ADVANCED_DELEGATED_REASONING_EFFORT
  );
}

/** Default delegated effort by model tier; preserve inheritance for other models. */
export function defaultDelegatedReasoningEffort(
  provider: string | undefined,
  modelId: string | undefined,
  inherited: string,
): string {
  return usesDelegatedSolTier(provider, modelId)
    ? DEFAULT_DELEGATED_REASONING_EFFORT
    : inherited;
}
