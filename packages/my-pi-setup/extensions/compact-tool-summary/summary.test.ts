import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyToolActivities,
  classifyToolName,
  formatToolSummary,
  isFileMutationTool,
  isFullOutputTool,
  shouldSummarizeTool,
} from "./summary.ts";
import { createPatchLifecycle } from "./tool-component-lifecycle.ts";

test("formats Claude-style grouped activity", () => {
  assert.equal(
    formatToolSummary({
      items: [
        { toolName: "read", label: "read", count: 3 },
        { toolName: "bash", label: "bash", count: 1 },
        { toolName: "web_search", label: "Web Search", count: 2 },
      ],
      failed: 0,
    }),
    "Read 3 files, ran 1 shell command, searched web 2 times",
  );
});

test("uses custom labels and reports failures", () => {
  assert.equal(
    formatToolSummary({
      items: [{ toolName: "subagent_spawn", label: "Subagent Spawn", count: 2 }],
      failed: 1,
    }),
    "Called Subagent Spawn 2 times, 1 call failed",
  );
});

test("classifies common shell inspection commands", () => {
  assert.equal(classifyToolName("exec_command", { cmd: "ls -la" }), "ls");
  assert.equal(classifyToolName("exec_command", { cmd: "rg --files src" }), "find");
  assert.equal(classifyToolName("exec_command", { cmd: "rg -n TODO src" }), "grep");
  assert.equal(classifyToolName("exec_command", { cmd: "sed -n '1,40p' README.md" }), "read");
  assert.equal(classifyToolName("exec_command", { cmd: "npm test" }), "exec_command");
  assert.deepEqual(
    classifyToolActivities("exec_command", {
      cmd: "sed -n '1,40p' one.ts; printf '\\n---\\n'; cat two.ts; sed -n '1,20p' three.ts",
    }),
    [{ toolName: "read", count: 3 }],
  );
  assert.deepEqual(
    classifyToolActivities("exec_command", {
      cmd: "cat one.ts; rg -n TODO two.ts",
    }),
    [
      { toolName: "read", count: 1 },
      { toolName: "grep", count: 1 },
    ],
  );
});

test("preserves patch-rendering tools", () => {
  assert.equal(isFileMutationTool("edit"), true);
  assert.equal(isFileMutationTool("write"), true);
  assert.equal(isFileMutationTool("apply_patch"), true);
  assert.equal(isFileMutationTool("tools.apply_patch"), true);
  assert.equal(isFileMutationTool("read"), false);
});

test("preserves workflow and file mutation output", () => {
  assert.equal(isFullOutputTool("workflow"), true);
  assert.equal(isFullOutputTool("tools.workflow"), true);
  assert.equal(isFullOutputTool("apply_patch"), true);
  assert.equal(isFullOutputTool("read"), false);
  assert.equal(shouldSummarizeTool("workflow"), false);
  assert.equal(shouldSummarizeTool("apply_patch"), false);
  assert.equal(shouldSummarizeTool("read"), true);
});

test("headless child lifecycle cannot restore interactive parent patch", async () => {
  let patched = false;
  let installs = 0;
  const install = async () => {
    installs += 1;
    patched = true;
    return () => {
      patched = false;
    };
  };
  const parent = createPatchLifecycle(install);
  const child = createPatchLifecycle(install);

  await parent.start("tui");
  assert.equal(patched, true);
  await child.start("print");
  child.stop();

  assert.equal(installs, 1);
  assert.equal(patched, true);
  parent.stop();
  assert.equal(patched, false);
});
