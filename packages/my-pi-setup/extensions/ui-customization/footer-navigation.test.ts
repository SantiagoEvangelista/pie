import assert from "node:assert/strict";
import test from "node:test";
import {
  FooterActionSelection,
  FOOTER_ACTIONS,
} from "./footer-navigation.ts";

test("footer actions wrap left and right deterministically", () => {
  const selection = new FooterActionSelection();

  assert.deepEqual(FOOTER_ACTIONS, ["workflows", "subagents"]);
  assert.equal(selection.current(), "workflows");
  assert.deepEqual(selection.handle("right"), {
    returnToEditor: false,
    selectionChanged: true,
  });
  assert.equal(selection.current(), "subagents");
  selection.handle("right");
  assert.equal(selection.current(), "workflows");
  selection.handle("left");
  assert.equal(selection.current(), "subagents");
});

test("confirm opens selection while Up and Escape return to editor", () => {
  const selection = new FooterActionSelection();
  selection.handle("right");

  assert.deepEqual(selection.handle("confirm"), {
    action: "subagents",
    returnToEditor: true,
    selectionChanged: false,
  });
  assert.deepEqual(selection.handle("up"), {
    returnToEditor: true,
    selectionChanged: false,
  });
  assert.deepEqual(selection.handle("cancel"), {
    returnToEditor: true,
    selectionChanged: false,
  });
});
