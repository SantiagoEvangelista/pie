import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveWorkflowBackground } from "./background-policy.ts";

test("interactive workflows default to background with an explicit blocking opt-out", () => {
  assert.equal(resolveWorkflowBackground(undefined, true), true);
  assert.equal(resolveWorkflowBackground(true, true), true);
  assert.equal(resolveWorkflowBackground(false, true), false);
});

test("headless workflows always block", () => {
  assert.equal(resolveWorkflowBackground(undefined, false), false);
  assert.equal(resolveWorkflowBackground(true, false), false);
  assert.equal(resolveWorkflowBackground(false, false), false);
});

test("background launch terminates parent turn and prompt forbids polling", () => {
  const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const promptSource = readFileSync(new URL("./prompt.ts", import.meta.url), "utf8");

  assert.match(indexSource, /terminate: true/);
  assert.match(promptSource, /end the current turn/i);
  assert.match(promptSource, /do not poll/i);
  assert.match(promptSource, /background: false/);
});
