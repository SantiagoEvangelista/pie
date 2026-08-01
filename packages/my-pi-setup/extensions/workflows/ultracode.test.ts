import assert from "node:assert/strict";
import test from "node:test";
import { ultracodeSystemPrompt } from "./ultracode.ts";

test("ultracode injects standing workflow policy", () => {
  const prompt = ultracodeSystemPrompt("base", "ultracode");
  assert.match(prompt ?? "", /Ultracode mode is active/);
  assert.match(prompt ?? "", /workflow as the default execution path/);
});

test("ordinary thinking levels do not inject workflow policy", () => {
  assert.equal(ultracodeSystemPrompt("base", "xhigh"), undefined);
  assert.equal(ultracodeSystemPrompt("base", "max"), undefined);
});
