import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPersistentBackground,
  renderFocusedActionLabel,
} from "./theme-rendering.ts";

test("editor background survives simple and compound ANSI resets", () => {
  const background = "\x1b[48;2;38;38;38m";
  const [line] = applyPersistentBackground(
    ["plain\x1b[0mzero\x1b[mempty\x1b[1;49mcompound\x1b[31mred"],
    background,
  );

  assert.equal(
    line,
    `${background}plain\x1b[0m${background}zero\x1b[m${background}empty\x1b[1;49m${background}compound\x1b[31mred\x1b[49m`,
  );
});

test("editor background wraps every rendered line", () => {
  const background = "\x1b[48;5;235m";
  assert.deepEqual(applyPersistentBackground(["one", "two"], background), [
    `${background}one\x1b[49m`,
    `${background}two\x1b[49m`,
  ]);
});

test("focused footer action uses bold white text without background", () => {
  const theme = {
    fg: (color: "text", text: string) => `<${color}>${text}</${color}>`,
    bold: (text: string) => `<bold>${text}</bold>`,
  };

  const label = renderFocusedActionLabel(theme, "Workflows");
  assert.equal(label, "<bold><text>Workflows</text></bold>");
  assert.doesNotMatch(label, /background|bg/i);
});
