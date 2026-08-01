import assert from "node:assert/strict";
import test from "node:test";
import {
  isUltracodeThinkingLevel,
  toProviderThinkingLevel,
} from "./thinking-level.ts";

test("ultracode is a virtual xhigh provider level", () => {
  assert.equal(isUltracodeThinkingLevel("ultracode"), true);
  assert.equal(isUltracodeThinkingLevel("xhigh"), false);
  assert.equal(toProviderThinkingLevel("ultracode"), "xhigh");
  assert.equal(toProviderThinkingLevel("max"), "max");
  assert.equal(toProviderThinkingLevel(undefined), undefined);
});
