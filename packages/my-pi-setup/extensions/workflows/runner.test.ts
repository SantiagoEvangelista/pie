import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentSession,
  AgentSessionEventListener,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  boundAgentOutput,
  classifyAgentFailure,
  createCompactionWatchdog,
  createFirstResponseWatchdog,
  guardWorkflowChildTools,
  latestAssistantStatus,
  recordToolExecutionTiming,
  transcriptFromMessages,
  withCurrentContextTokens,
  type ToolExecutionTiming,
} from "./runner.ts";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

test("context occupancy clears when current usage is unknown after compaction", () => {
  const usage = {
    ...zeroUsage,
    cost: 0,
    turns: 1,
    contextTokens: 12_345,
  };

  const cleared = withCurrentContextTokens(usage, null);
  assert.equal(cleared.contextTokens, undefined);
  assert.equal(usage.contextTokens, 12_345);
  assert.deepEqual(
    withCurrentContextTokens(cleared, 678),
    { ...cleared, contextTokens: 678 },
  );
});

test("explicit compaction errors classify terminal run as failed", () => {
  assert.equal(
    classifyAgentFailure("stop", "Auto-compaction failed: provider rejected summary"),
    "Auto-compaction failed: provider rejected summary",
  );
});

test("successful retry clears an earlier assistant context error", () => {
  const messages = [
    {
      role: "assistant" as const,
      content: [],
      api: "fixture",
      provider: "fixture",
      model: "fixture",
      usage: zeroUsage,
      stopReason: "error" as const,
      errorMessage: "context overflow",
      timestamp: 1,
    },
    {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "recovered" }],
      api: "fixture",
      provider: "fixture",
      model: "fixture",
      usage: zeroUsage,
      stopReason: "stop" as const,
      timestamp: 2,
    },
  ] as AgentSession["messages"];

  assert.deepEqual(latestAssistantStatus(messages), {
    stopReason: "stop",
    errorMessage: undefined,
  });
});

test("length stop reason classifies failure with bounded partial-output message", () => {
  const failure = classifyAgentFailure("length");
  assert.match(failure ?? "", /output length limit/i);
  assert.ok((failure?.length ?? Infinity) < 1_024);
});

test("oversized agent output stays bounded and preserves full text separately", () => {
  const source = `${"é".repeat(40_000)}TAIL`;
  const bounded = boundAgentOutput(source, 1_024);

  assert.ok(Buffer.byteLength(bounded.output, "utf8") <= 1_024);
  assert.match(bounded.output, /full text saved in per-agent artifact/);
  assert.equal(bounded.fullOutput, source);
  assert.ok(Buffer.byteLength(boundAgentOutput(source, 8).output, "utf8") <= 8);
});

function parallelToolMessages(): AgentSession["messages"] {
  return [
    { role: "user", content: "run both", timestamp: 900 },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-a",
          name: "first",
          arguments: { value: 1 },
        },
        {
          type: "toolCall",
          id: "call-b",
          name: "second",
          arguments: { value: 2 },
        },
      ],
      api: "openai-responses",
      provider: "fixture",
      model: "fixture",
      usage: zeroUsage,
      stopReason: "toolUse",
      timestamp: 950,
    },
    {
      role: "toolResult",
      toolCallId: "call-a",
      toolName: "first",
      content: [{ type: "text", text: "first result" }],
      isError: false,
      timestamp: 1_040,
    },
    {
      role: "toolResult",
      toolCallId: "call-b",
      toolName: "second",
      content: [{ type: "text", text: "second result" }],
      isError: false,
      timestamp: 1_041,
    },
  ];
}

test("completed parallel tool calls pair lifecycle timings with calls and results", () => {
  const timings = new Map<string, ToolExecutionTiming>();
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "first",
      args: { value: 1 },
    },
    1_000,
  );
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-b",
      toolName: "second",
      args: { value: 2 },
    },
    1_002,
  );
  // Parallel calls can finish in a different order than their result messages.
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_end",
      toolCallId: "call-b",
      toolName: "second",
      result: { content: [{ type: "text", text: "second result" }] },
      isError: false,
    },
    1_012,
  );
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_end",
      toolCallId: "call-a",
      toolName: "first",
      result: { content: [{ type: "text", text: "first result" }] },
      isError: false,
    },
    1_030,
  );

  const transcript = transcriptFromMessages(parallelToolMessages(), timings);
  const toolEntries = transcript.filter((entry) => entry.role === "tool");
  const resultEntries = transcript.filter(
    (entry) => entry.role === "toolResult",
  );

  for (const entries of [toolEntries, resultEntries]) {
    assert.deepEqual(
      entries.map(({ toolCallId, startedAt, finishedAt, durationMs }) => ({
        toolCallId,
        startedAt,
        finishedAt,
        durationMs,
      })),
      [
        {
          toolCallId: "call-a",
          startedAt: 1_000,
          finishedAt: 1_030,
          durationMs: 30,
        },
        {
          toolCallId: "call-b",
          startedAt: 1_002,
          finishedAt: 1_012,
          durationMs: 10,
        },
      ],
    );
  }
});

test("in-flight aborted tool calls retain start timing without completion", () => {
  const timings = new Map<string, ToolExecutionTiming>();
  recordToolExecutionTiming(
    timings,
    {
      type: "tool_execution_start",
      toolCallId: "call-a",
      toolName: "first",
      args: { value: 1 },
    },
    2_000,
  );

  const transcript = transcriptFromMessages(
    parallelToolMessages().slice(0, 2),
    timings,
  );
  const first = transcript.find((entry) => entry.toolCallId === "call-a");

  assert.equal(first?.startedAt, 2_000);
  assert.equal(first?.finishedAt, undefined);
  assert.equal(first?.durationMs, undefined);
  assert.equal(
    transcript.some((entry) => entry.role === "toolResult"),
    false,
  );
});

test("first-response watchdog aborts a silent provider request", async () => {
  let aborted = false;
  const watchdog = createFirstResponseWatchdog(
    async () => {
      aborted = true;
    },
    { timeoutMs: 10, model: "fixture-model" },
  );

  await assert.rejects(
    watchdog.waitFor(new Promise<never>(() => {})),
    /no assistant response event for fixture-model within 10 ms.*stalled/i,
  );
  assert.equal(aborted, true);
});

test("first assistant response disarms the watchdog without limiting the run", async () => {
  const watchdog = createFirstResponseWatchdog(
    async () => {
      throw new Error("watchdog should have been disarmed");
    },
    { timeoutMs: 10 },
  );
  watchdog.markResponse();

  const result = await watchdog.waitFor(
    new Promise<string>((resolve) => setTimeout(() => resolve("done"), 20)),
  );
  assert.equal(result, "done");
});

test("response watchdog rearms for a later model request", async () => {
  let aborted = false;
  const watchdog = createFirstResponseWatchdog(
    async () => {
      aborted = true;
    },
    { timeoutMs: 10 },
  );
  watchdog.markResponse();
  watchdog.markRequest();

  await assert.rejects(
    watchdog.waitFor(new Promise<never>(() => {})),
    /no assistant response event.*10 ms/i,
  );
  assert.equal(aborted, true);
});

test("compaction watchdog aborts a stuck summary request", async () => {
  let aborted = false;
  const watchdog = createCompactionWatchdog(
    async () => {
      aborted = true;
    },
    { timeoutMs: 10, model: "fixture-model" },
  );
  watchdog.markStart("overflow");

  await assert.rejects(
    watchdog.waitFor(new Promise<never>(() => {})),
    /compaction \(overflow\) for fixture-model.*10 ms/i,
  );
  assert.equal(aborted, true);
});

test("completed compaction disarms its watchdog", async () => {
  const watchdog = createCompactionWatchdog(
    async () => {
      throw new Error("watchdog should have been disarmed");
    },
    { timeoutMs: 10 },
  );
  watchdog.markStart("threshold");
  watchdog.markEnd();

  const result = await watchdog.waitFor(
    new Promise<string>((resolve) => setTimeout(() => resolve("done"), 20)),
  );
  assert.equal(result, "done");
});

test("workflow children guard structured, normal, and dynamically registered tools", async () => {
  const structuredResult = {
    content: [{ type: "text" as const, text: "recorded" }],
    details: { value: "fixture" },
    terminate: true,
  };
  const structured = {
    name: "structured_output",
    label: "Structured Output",
    description: "fixture",
    parameters: Type.Object({}),
    async execute() {
      return structuredResult;
    },
  } satisfies ToolDefinition;
  const definitions = new Map<string, ToolDefinition>([
    [structured.name, structured],
  ]);
  let listener: AgentSessionEventListener | undefined;
  const session = {
    getAllTools: () => [...definitions.keys()].map((name) => ({ name })),
    getToolDefinition: (name: string) => definitions.get(name),
    subscribe(next: AgentSessionEventListener) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };

  const unsubscribe = guardWorkflowChildTools(session, 10);
  assert.equal(await structured.execute(), structuredResult);

  let dynamicSignal: AbortSignal | undefined;
  const dynamic = {
    name: "dynamic_fixture",
    label: "Dynamic Fixture",
    description: "fixture",
    parameters: Type.Object({}),
    async execute(
      _toolCallId: string,
      _params: Record<string, never>,
      signal?: AbortSignal,
    ) {
      dynamicSignal = signal;
      return new Promise<never>(() => {});
    },
  } satisfies ToolDefinition;
  const originalDynamicExecute = dynamic.execute;
  definitions.set(dynamic.name, dynamic);
  listener?.({ type: "agent_start" });
  assert.notEqual(dynamic.execute, originalDynamicExecute);

  await assert.rejects(
    dynamic.execute("fixture", {}, undefined),
    /Tool call "dynamic_fixture" timed out after 10 ms\./,
  );
  assert.equal(dynamicSignal?.aborted, true);
  unsubscribe();
});
