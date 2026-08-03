import assert from "node:assert/strict";
import test from "node:test";
import { ultracodeSystemPrompt } from "./ultracode.ts";

test("ultracode injects standing workflow policy", () => {
  const prompt = ultracodeSystemPrompt("base", "ultracode");
  assert.match(prompt ?? "", /Ultracode mode is active/);
  assert.match(prompt ?? "", /workflow as default execution path/);
  assert.match(prompt ?? "", /GPT-5\.6 Sol\/ultracode parent/);
  assert.match(prompt ?? "", /highest-capability orchestrator/);
  assert.match(prompt ?? "", /3-4 orthogonal workers/);
  assert.match(prompt ?? "", /at least 2 independent verification/);
  assert.match(prompt ?? "", /Sol must decompose before delegation/);
  assert.match(prompt ?? "", /not a compound inspect\/design\/implement\/test role/);
  assert.match(prompt ?? "", /split it into more calls or later batches/);
  assert.match(prompt ?? "", /one owned file or tightly coupled file set/);
  assert.match(prompt ?? "", /named out-of-scope work/);
  assert.match(prompt ?? "", /GPT-5\.6 Sol at medium effort/);
  assert.match(prompt ?? "", /GPT-5\.6 Sol at high effort/);
  assert.doesNotMatch(prompt ?? "", /Luna|Terra|Kimi/);
  assert.match(prompt ?? "", /prohibit lateral exploration/);
});

test("ordinary thinking levels do not inject workflow policy", () => {
  assert.equal(ultracodeSystemPrompt("base", "xhigh"), undefined);
  assert.equal(ultracodeSystemPrompt("base", "max"), undefined);
});
