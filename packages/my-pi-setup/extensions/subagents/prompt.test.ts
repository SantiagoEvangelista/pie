import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSubagentSendResult,
  buildSubagentSpawnResult,
  SUBAGENT_SEND_PARAMETER_DESCRIPTIONS,
  SUBAGENT_SEND_TOOL_DESCRIPTION,
  SUBAGENT_SPAWN_PROMPT_GUIDELINES,
} from "./src/prompt.ts";

test("subagent send prompt describes steering and same-context continuation", () => {
  assert.match(SUBAGENT_SEND_TOOL_DESCRIPTION, /active run/i);
  assert.match(SUBAGENT_SEND_TOOL_DESCRIPTION, /course correction/i);
  assert.match(SUBAGENT_SEND_TOOL_DESCRIPTION, /settled subagent resumes/i);
  assert.match(SUBAGENT_SEND_TOOL_DESCRIPTION, /conversation history preserved/i);
  assert.match(SUBAGENT_SEND_TOOL_DESCRIPTION, /without waiting/i);
  assert.match(SUBAGENT_SEND_PARAMETER_DESCRIPTIONS.message, /non-empty/i);
  assert.ok(
    SUBAGENT_SPAWN_PROMPT_GUIDELINES.some(
      (guideline) =>
        guideline.includes("subagent_send") &&
        guideline.includes("Do not use it for status polling"),
    ),
  );
});

test("subagent results advertise and acknowledge send", () => {
  const spawn = buildSubagentSpawnResult({
    id: "sa-7",
    title: "inspect",
    harness: "pi",
    modelLabel: "provider/model",
    cwd: "/tmp/project",
  });
  assert.match(spawn, /subagent_send/);

  assert.equal(
    buildSubagentSendResult({ id: "sa-7", title: "inspect" }),
    'Sent guidance to subagent sa-7 "inspect". It continues in the background.',
  );
});
