import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ADVANCED_DELEGATED_MODEL_ID,
  ADVANCED_DELEGATED_PROVIDER,
  ADVANCED_DELEGATED_REASONING_EFFORT,
  DEFAULT_DELEGATED_MODEL_ID,
  DEFAULT_DELEGATED_PROVIDER,
  DEFAULT_DELEGATED_REASONING_EFFORT,
  delegatedPromptValidationError,
  defaultDelegatedReasoningEffort,
  DELEGATED_MODEL_TIERING_GUIDELINES,
  isDelegatedReasoningEffortAllowed,
  ORCHESTRATOR_MODEL_ID,
} from "./intelligence-tiering.ts";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const subagentPromptSource = source("../subagents/src/prompt.ts");
const subagentBackendSource = source("../subagents/src/backends/pi.ts");
const subagentRoutingSource = source("../subagents/src/pi-model-routing.ts");
const workflowPromptSource = source("../workflows/prompt.ts");
const workflowRuntimeSource = source("../workflows/index.ts");
const workflowRoutingSource = source("../workflows/model-routing.ts");
const skillSource = source("../../skills/subagents/SKILL.md");
const readmeSource = source("../../README.md");
const globalPromptSource = source(
  "../../../../extensions/claude-system-prompt/prompt.md",
);

test("subagents and workflows share delegated model tiering", () => {
  assert.match(subagentPromptSource, /\.\.\.DELEGATED_MODEL_TIERING_GUIDELINES/);
  assert.match(workflowPromptSource, /\.\.\.DELEGATED_MODEL_TIERING_GUIDELINES/);
  assert.match(
    workflowPromptSource,
    /DELEGATED_MODEL_TIERING_GUIDELINES\.map/,
  );
});

test("policy reserves parent for orchestration and routes narrow child work", () => {
  const policy = DELEGATED_MODEL_TIERING_GUIDELINES.join("\n");

  assert.equal(DEFAULT_DELEGATED_PROVIDER, "openai-codex");
  assert.equal(DEFAULT_DELEGATED_MODEL_ID, "gpt-5.6-sol");
  assert.equal(DEFAULT_DELEGATED_REASONING_EFFORT, "medium");
  assert.equal(ADVANCED_DELEGATED_PROVIDER, "openai-codex");
  assert.equal(ADVANCED_DELEGATED_MODEL_ID, "gpt-5.6-sol");
  assert.equal(ADVANCED_DELEGATED_REASONING_EFFORT, "high");
  assert.equal(ORCHESTRATOR_MODEL_ID, "gpt-5.6-sol");
  assert.match(policy, /parent orchestrator/);
  assert.match(policy, /final synthesis/);
  assert.match(policy, /GPT-5\.6 Sol[\s\S]*medium effort/);
  assert.match(policy, /GPT-5\.6 Sol[\s\S]*high effort/);
  assert.match(policy, /3-4 orthogonal worker tasks/);
  assert.match(policy, /at least 2 independent verification/);
  assert.match(policy, /parent must reduce the assignment/);
  assert.match(policy, /Never delegate a compound inspect-plus-design-plus-implement-plus-test role/);
  assert.match(policy, /multiple independent files, questions, or deliverables/);
  assert.match(policy, /one question or change/);
  assert.match(policy, /explicit stop condition/);
  assert.match(policy, /open-ended discovery/);
  assert.match(policy, /Never prohibit read-only tool use/);
  assert.match(policy, /Parallel edits require disjoint ownership/);
  assert.doesNotMatch(policy, /Luna|Terra|Kimi/i);
});

test("source-dependent child prompts cannot ban inspection tools", () => {
  const reproducedPrompt =
    "Atomic RTL review of ONLY current `rtl/iridium/decimate_hb_tdm.v` change. Do not edit/run tools. Return blockers or PASS.";
  assert.match(
    delegatedPromptValidationError(reproducedPrompt) ?? "",
    /Source-dependent child prompt prohibits tool use/,
  );
  assert.equal(
    delegatedPromptValidationError(
      "Review only `rtl/iridium/decimate_hb_tdm.v`. Do not edit; use read-only tools. Return blockers or PASS.",
    ),
    undefined,
  );
  assert.equal(
    delegatedPromptValidationError(
      "Review this embedded diff without tools:\n```diff\n" +
        "+".repeat(100) +
        "\n```\nReturn blockers or PASS.",
    ),
    undefined,
  );
  assert.equal(
    delegatedPromptValidationError(
      "Reason about whether a bounded queue can deadlock. Do not use tools.",
    ),
    undefined,
  );
});

test("model-facing examples use Sol medium and Sol high", () => {
  assert.match(subagentPromptSource, /gpt-5\.6-sol/);
  assert.match(subagentPromptSource, /one atomic purpose/);
  assert.match(subagentPromptSource, /split compound work/i);
  assert.match(subagentPromptSource, /default to medium/);
  assert.match(subagentPromptSource, /use high for advanced work/);
  assert.match(workflowPromptSource, /one atomic purpose/);
  assert.match(workflowPromptSource, /separate calls or later batches/);
  assert.match(workflowPromptSource, /model: 'gpt-5\.6-sol'/);
  assert.match(workflowPromptSource, /model: 'gpt-5\.6-sol', effort: 'medium'/);
  assert.match(workflowPromptSource, /model: 'gpt-5\.6-sol', effort: 'high'/);
  assert.doesNotMatch(subagentPromptSource, /Luna|Terra|Kimi/i);
  assert.doesNotMatch(workflowPromptSource, /Luna|Terra|Kimi/i);
});

test("delegated model defaults set supported reasoning levels", () => {
  assert.equal(
    isDelegatedReasoningEffortAllowed(
      "openai-codex",
      "gpt-5.6-sol",
      "medium",
    ),
    true,
  );
  assert.equal(
    isDelegatedReasoningEffortAllowed(
      "openai-codex",
      "gpt-5.6-sol",
      "high",
    ),
    true,
  );
  assert.equal(
    isDelegatedReasoningEffortAllowed(
      "openai-codex",
      "gpt-5.6-sol",
      "max",
    ),
    false,
  );
  assert.equal(
    isDelegatedReasoningEffortAllowed("other-provider", "other-model", "max"),
    true,
  );
  assert.equal(
    defaultDelegatedReasoningEffort(
      "openai-codex",
      "gpt-5.6-sol",
      "high",
    ),
    "medium",
  );
  assert.equal(
    defaultDelegatedReasoningEffort("other-provider", "other-model", "medium"),
    "medium",
  );
});

test("both child runtimes select the worker model when model is omitted", () => {
  for (const runtimeSource of [subagentRoutingSource, workflowRoutingSource]) {
    assert.match(runtimeSource, /DEFAULT_DELEGATED_PROVIDER/);
    assert.match(runtimeSource, /DEFAULT_DELEGATED_MODEL_ID/);
  }
  assert.match(subagentRoutingSource, /if \(hint === undefined\)/);
  assert.match(subagentBackendSource, /resolvePiModel/);
  assert.match(subagentBackendSource, /isDelegatedReasoningEffortAllowed/);
  assert.match(workflowRoutingSource, /worker-tier default/);
  assert.match(workflowRuntimeSource, /resolveWorkflowModel/);
  assert.match(workflowRuntimeSource, /isDelegatedReasoningEffortAllowed/);
});

test("global prompt, skill, and README agree with active routing policy", () => {
  for (const policySource of [skillSource, readmeSource, globalPromptSource]) {
    assert.match(policySource, /gpt-5\.6-sol|Sol\/ultracode/i);
    assert.match(policySource, /Sol\/medium|Sol at medium effort/);
    assert.match(policySource, /Sol\/high|Sol at high effort/);
    assert.doesNotMatch(policySource, /Luna|Terra|Kimi/i);
  }
  assert.match(skillSource, /3-4 orthogonal workers/);
  assert.match(skillSource, /Never assign a child compound inspect\/design\/implement\/test work/);
  assert.match(globalPromptSource, /Default delegated work/);
  assert.match(globalPromptSource, /more calls or later batches/);
});
