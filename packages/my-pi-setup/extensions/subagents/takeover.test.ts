import assert from "node:assert/strict";
import test from "node:test";
import {
  fitSubagentDashboardLines,
  openSubagentPicker,
  reconcileDashboardSelection,
  type DashboardSelection,
} from "./src/ui/takeover.ts";

test("dashboard selection follows its subagent id and falls back by row", () => {
  const selection: DashboardSelection = { id: "sa-7", index: 6 };

  reconcileDashboardSelection(selection, [
    { id: "sa-new" },
    ...Array.from({ length: 8 }, (_, index) => ({ id: `sa-${index + 1}` })),
  ]);
  assert.deepEqual(selection, { id: "sa-7", index: 7 });

  reconcileDashboardSelection(selection, [
    ...Array.from({ length: 6 }, (_, index) => ({ id: `sa-${index + 1}` })),
    { id: "sa-8" },
    { id: "sa-9" },
  ]);
  assert.deepEqual(selection, { id: "sa-9", index: 7 });

  reconcileDashboardSelection(selection, [{ id: "sa-1" }, { id: "sa-2" }]);
  assert.deepEqual(selection, { id: "sa-2", index: 1 });

  reconcileDashboardSelection(selection, []);
  assert.deepEqual(selection, { id: undefined, index: 0 });
});

test("dashboard output never exceeds narrow terminal width", () => {
  const lines = ["Subagents", "│ content │", "\x1b[31mcolored content\x1b[0m"];

  for (let width = 0; width <= 5; width += 1) {
    const fitted = fitSubagentDashboardLines(lines, width);
    assert.equal(fitted.length, lines.length);
    for (const line of fitted) {
      const plain = line.replace(/\x1b\[[0-9;]*m/g, "");
      assert.ok([...plain].length <= width, `${JSON.stringify(line)} exceeds ${width}`);
    }
  }
});

test("empty subagent state still opens the dashboard page", async () => {
  let customCalls = 0;
  let notifications = 0;
  const ctx = {
    ui: {
      async custom() {
        customCalls += 1;
        return null;
      },
      notify() {
        notifications += 1;
      },
    },
  };
  const view = {
    size: () => 0,
  };

  await openSubagentPicker(ctx as never, view as never);
  assert.equal(customCalls, 1);
  assert.equal(notifications, 0);
});
