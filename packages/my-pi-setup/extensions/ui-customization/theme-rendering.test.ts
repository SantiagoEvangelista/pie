import assert from "node:assert/strict";
import test from "node:test";
import { renderFocusedActionLabel } from "./theme-rendering.ts";

test("focused footer action uses bold white text without background", () => {
  const theme = {
    fg: (color: "text", text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<bold>${text}</bold>`,
  };

  const label = renderFocusedActionLabel(theme, "Workflows");
  assert.equal(label, "<bold><text>Workflows</text></bold>");
  assert.doesNotMatch(label, /background|bg/i);
});
