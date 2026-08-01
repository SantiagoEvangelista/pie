import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  defaultDelegatedReasoningEffort,
  DELEGATED_MODEL_TIERING_GUIDELINES,
} from "./intelligence-tiering.ts";

const subagentPromptSource = readFileSync(
  new URL("../subagents/src/prompt.ts", import.meta.url),
  "utf8",
);
const workflowPromptSource = readFileSync(
  new URL("../workflows/prompt.ts", import.meta.url),
  "utf8",
);

test("subagents and workflows share delegated model tiering", () => {
  assert.match(subagentPromptSource, /\.\.\.DELEGATED_MODEL_TIERING_GUIDELINES/);
  assert.match(workflowPromptSource, /\.\.\.DELEGATED_MODEL_TIERING_GUIDELINES/);
  assert.match(
    workflowPromptSource,
    /DELEGATED_MODEL_TIERING_GUIDELINES\.map/,
  );
});

test("tiering uses Sol medium/high and rejects Luna", () => {
  const policy = DELEGATED_MODEL_TIERING_GUIDELINES.join("\n");

  assert.match(policy, /Classify each delegated task/);
  assert.match(policy, /Bounded execution tier/);
  assert.match(policy, /Advanced reasoning tier/);
  assert.match(policy, /Disallowed tier/);
  assert.match(policy, /openai-codex\/gpt-5\.6-sol/);
  assert.match(policy, /GPT-5\.6 Luna: do not use it/);
  assert.match(policy, /Bounded execution tier[\s\S]*Sol[\s\S]*medium effort/);
  assert.match(policy, /Advanced reasoning tier[\s\S]*Sol[\s\S]*high effort/);
  assert.match(policy, /do not inherit the expensive orchestrator accidentally/);
  assert.match(subagentPromptSource, /gpt-5\.6-sol/);
  assert.match(workflowPromptSource, /model: 'gpt-5\.6-sol'/);
  assert.match(workflowPromptSource, /model: 'gpt-5\.6-sol', effort: 'medium'/);
  assert.match(workflowPromptSource, /model: 'gpt-5\.6-sol', effort: 'high'/);
  assert.doesNotMatch(policy, /gpt-5\.6-terra/i);
  assert.doesNotMatch(subagentPromptSource, /gpt-5\.6-terra/i);
  assert.doesNotMatch(workflowPromptSource, /gpt-5\.6-terra/i);
});

test("delegated Sol defaults to medium while explicit advanced work uses high", () => {
  assert.equal(defaultDelegatedReasoningEffort("gpt-5.6-sol", "xhigh"), "medium");
  assert.equal(defaultDelegatedReasoningEffort("other-model", "medium"), "medium");
});
