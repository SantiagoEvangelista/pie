import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const piBin = execFileSync("/bin/sh", ["-lc", "command -v pi"], {
  encoding: "utf8",
}).trim();
const piRoot =
  process.env.PI_CODING_AGENT_PACKAGE ??
  path.join(path.dirname(path.dirname(piBin)), "lib/node_modules/@earendil-works/pi-coding-agent");
const conversionRoot =
  process.env.PI_CODEX_CONVERSION_PACKAGE ??
  path.join(os.homedir(), ".pi/agent/npm/node_modules/@howaboua/pi-codex-conversion");

async function importFile(root, relativePath) {
  return import(pathToFileURL(path.join(root, relativePath)).href);
}

const { AgentSession } = await importFile(piRoot, "dist/core/agent-session.js");
const { ExtensionRunner } = await importFile(
  piRoot,
  "dist/core/extensions/runner.js",
);
const { buildContextEntries } = await importFile(
  piRoot,
  "dist/core/session-manager.js",
);
const { prepareCompaction } = await importFile(
  piRoot,
  "dist/core/compaction/compaction.js",
);
const { buildRemoteCompactionV2Window } = await importFile(
  conversionRoot,
  "dist/adapter/compaction/remote-v2-history.js",
);
const { createNativeCompactionDetails, isNativeCompactionDetails } = await importFile(
  conversionRoot,
  "dist/adapter/compaction/types.js",
);
const { serializeMessagesToResponsesInput } = await importFile(
  conversionRoot,
  "dist/adapter/compaction/serializer.js",
);
const { rewriteResponsesPayloadWithNativeReplay } = await importFile(
  conversionRoot,
  "dist/adapter/replay/payload-rewrite.js",
);
const { executeRemoteCompactionV2 } = await importFile(
  conversionRoot,
  "dist/adapter/compaction/remote-v2-client.js",
);
const { EXEC_DESCRIPTION } = await importFile(
  conversionRoot,
  "dist/tools/code-mode/custom-tool-prompt.js",
);
const { isNativeLookingCompactionEntry, resolveLatestNativeCompactionEntry } = await importFile(
  conversionRoot,
  "dist/adapter/compaction/details-store.js",
);
const { requestBodyUsesRemoteCompactionV2, withRemoteCompactionV2ForBody } = await importFile(
  conversionRoot,
  "dist/providers/openai-codex-custom-provider.js",
);

const model = {
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  provider: "openai-codex",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272_000,
  maxTokens: 128_000,
};

test("compaction coordinator allows only one owner", () => {
  const target = {
    _compactionInProgress: false,
    _compactionAbortController: undefined,
    _autoCompactionAbortController: undefined,
  };
  const manual = AgentSession.prototype._beginCompaction.call(target, "manual");
  const overlapping = AgentSession.prototype._beginCompaction.call(target, "auto");
  assert.ok(manual);
  assert.equal(overlapping, undefined);
  AgentSession.prototype._finishCompaction.call(
    target,
    "manual",
    new AbortController(),
  );
  assert.equal(target._compactionInProgress, true);
  AgentSession.prototype._finishCompaction.call(target, "manual", manual);
  assert.equal(target._compactionInProgress, false);
});

test("auto-compaction is cancellable while authentication is pending", async () => {
  let resolveAuth;
  const auth = new Promise((resolve) => {
    resolveAuth = resolve;
  });
  const branch = [
    { type: "session", id: "s", parentId: null },
    {
      type: "message",
      id: "u1",
      parentId: "s",
      message: { role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      message: { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 },
    },
    {
      type: "message",
      id: "u2",
      parentId: "a1",
      message: { role: "user", content: [{ type: "text", text: "recent" }], timestamp: 3 },
    },
  ];
  const events = [];
  const target = {
    _compactionInProgress: false,
    _compactionAbortController: undefined,
    _autoCompactionAbortController: undefined,
    _beginCompaction: AgentSession.prototype._beginCompaction,
    _finishCompaction: AgentSession.prototype._finishCompaction,
    _captureCompactionSnapshot: AgentSession.prototype._captureCompactionSnapshot,
    _assertCompactionSnapshotCurrent: AgentSession.prototype._assertCompactionSnapshotCurrent,
    model,
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => "u2",
      getBranch: () => branch,
    },
    settingsManager: {
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 100, keepRecentTokens: 1 }),
    },
    agent: { streamFunction: () => {} },
    _getSummarizationRequestAuth: () => auth,
    _emit: (event) => events.push(event),
  };
  const running = AgentSession.prototype._runAutoCompaction.call(
    target,
    "threshold",
    false,
  );
  assert.equal(events[0]?.type, "compaction_start");
  AgentSession.prototype.abortCompaction.call(target);
  resolveAuth({ apiKey: "key", headers: {}, env: {} });
  assert.equal(await running, false);
  assert.equal(events.at(-1)?.type, "compaction_end");
  assert.equal(events.at(-1)?.aborted, true);
});

test("stable Code Mode prompt defines exec result contract", () => {
  assert.match(EXEC_DESCRIPTION, /result\.output/);
  assert.match(EXEC_DESCRIPTION, /never result\.stdout\/result\.stderr/);
});

test("stale compaction snapshots and invalid boundaries cannot commit", () => {
  let branch = [{ id: "a", value: "original" }, { id: "b" }];
  const sessionManager = {
    getSessionId: () => "session",
    getLeafId: () => branch.at(-1)?.id,
    getBranch: () => branch,
  };
  const target = { sessionManager };
  const snapshot = AgentSession.prototype._captureCompactionSnapshot.call(
    target,
    branch,
  );
  const signal = new AbortController().signal;
  assert.doesNotThrow(() =>
    AgentSession.prototype._assertCompactionSnapshotCurrent.call(
      target,
      snapshot,
      "a",
      signal,
    ),
  );
  assert.throws(
    () =>
      AgentSession.prototype._assertCompactionSnapshotCurrent.call(
        target,
        snapshot,
        "missing",
        signal,
      ),
    /invalid kept-entry boundary/,
  );
  branch[0].value = "mutated";
  assert.throws(
    () =>
      AgentSession.prototype._assertCompactionSnapshotCurrent.call(
        target,
        snapshot,
        "a",
        signal,
      ),
    /context changed/,
  );
  branch[0].value = "original";
  branch = [...branch, { id: "c" }];
  assert.throws(
    () =>
      AgentSession.prototype._assertCompactionSnapshotCurrent.call(
        target,
        snapshot,
        "a",
        signal,
      ),
    /context changed/,
  );
});

test("compaction snapshots reject model and effort changes", () => {
  const branch = [{ id: "a" }];
  const firstModel = { provider: "one", id: "model", api: "api", baseUrl: "https://one" };
  const target = {
    model: firstModel,
    thinkingLevel: "high",
    sessionManager: {
      getSessionId: () => "session",
      getLeafId: () => "a",
      getBranch: () => branch,
    },
  };
  const snapshot = AgentSession.prototype._captureCompactionSnapshot.call(
    target,
    branch,
    firstModel,
    "high",
  );
  target.model = { ...firstModel, provider: "two", baseUrl: "https://two" };
  assert.throws(
    () => AgentSession.prototype._assertCompactionSnapshotCurrent.call(
      target,
      snapshot,
      "a",
      new AbortController().signal,
    ),
    /model or thinking level changed/,
  );
});

test("invalid boundary is discarded during subsequent compaction preparation", () => {
  const user = (text, timestamp) => ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  });
  const entries = [
    { type: "session", id: "s", parentId: null },
    { type: "message", id: "old", parentId: "s", message: user("LOST-HISTORY", 1) },
    {
      type: "compaction",
      id: "bad",
      parentId: "old",
      firstKeptEntryId: "missing",
      summary: "OPAQUE-PLACEHOLDER",
      tokensBefore: 100,
    },
    { type: "message", id: "tail", parentId: "bad", message: user("TAIL", 2) },
  ];
  const preparation = prepareCompaction(entries, {
    enabled: true,
    reserveTokens: 100,
    keepRecentTokens: 0,
  });
  assert.equal(preparation.previousSummary, undefined);
  assert.match(JSON.stringify(preparation.messagesToSummarize), /LOST-HISTORY/);
  assert.doesNotMatch(
    JSON.stringify(preparation.messagesToSummarize),
    /OPAQUE-PLACEHOLDER/,
  );

  const terminalEntries = entries.slice(0, 3);
  const terminalPreparation = prepareCompaction(terminalEntries, {
    enabled: true,
    reserveTokens: 100,
    keepRecentTokens: 0,
  });
  assert.equal(terminalPreparation.previousSummary, undefined);
  assert.equal(terminalPreparation.firstKeptEntryId, "bad");
  assert.match(
    JSON.stringify(terminalPreparation.messagesToSummarize),
    /LOST-HISTORY/,
  );

  const repaired = {
    type: "compaction",
    id: "repaired",
    parentId: "bad",
    firstKeptEntryId: "bad",
    summary: "readable repair",
    tokensBefore: 100,
  };
  const repairedEntries = [...terminalEntries, repaired];
  const repairedContext = buildContextEntries(
    repairedEntries,
    "repaired",
    new Map(repairedEntries.map((entry) => [entry.id, entry])),
  );
  assert.deepEqual(repairedContext.map((entry) => entry.id), ["repaired"]);
});

test("next-turn hooks receive compacted context and retain their overrides", async () => {
  let hookInput;
  const agent = {
    state: {
      model: { id: "base" },
      thinkingLevel: "high",
      tools: [{ name: "base-tool" }],
    },
    prepareNextTurnWithContext: async (turn) => {
      hookInput = turn.context;
      return {
        context: {
          ...turn.context,
          systemPrompt: "hook-system",
          tools: [{ name: "hook-tool" }],
        },
        model: { id: "hook-model" },
        thinkingLevel: "xhigh",
      };
    },
  };
  const target = {
    agent,
    _baseSystemPrompt: "base-system",
    _systemPromptOverride: undefined,
    _compactBetweenAgentTurns: async (context) => ({
      ...context,
      messages: ["compacted"],
    }),
  };
  AgentSession.prototype._installAgentNextTurnRefresh.call(target);
  const result = await agent.prepareNextTurnWithContext(
    { context: { messages: ["old"] } },
    new AbortController().signal,
  );
  assert.deepEqual(hookInput.messages, ["compacted"]);
  assert.equal(result.context.systemPrompt, "hook-system");
  assert.deepEqual(result.context.tools, [{ name: "hook-tool" }]);
  assert.equal(result.model.id, "hook-model");
  assert.equal(result.thinkingLevel, "xhigh");
});

test("invalid persisted boundary exposes readable history instead of dropping it", () => {
  const entries = [
    { type: "session", id: "s", parentId: null },
    { type: "message", id: "u", parentId: "s", message: { role: "user" } },
    {
      type: "compaction",
      id: "c",
      parentId: "u",
      firstKeptEntryId: "missing",
      summary: "opaque placeholder",
    },
  ];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const context = buildContextEntries(entries, "c", byId);
  assert.deepEqual(
    context.map((entry) => entry.id),
    ["s", "u"],
  );
});

test("persisted native windows require canonical ordering", () => {
  const identity = {
    strategy: "openai-responses-compaction-v2",
    provider: "openai-codex",
    api: "openai-codex-responses",
    model: "gpt-5.6-sol",
    baseUrl: "https://chatgpt.com/backend-api",
    createdAt: new Date().toISOString(),
  };
  const user = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "keep" }],
  };
  const checkpoint = { type: "compaction", encrypted_content: "sealed" };
  assert.equal(
    isNativeCompactionDetails({
      ...identity,
      compactedWindow: [user, checkpoint],
    }),
    true,
  );
  assert.equal(
    isNativeCompactionDetails({
      ...identity,
      compactedWindow: [checkpoint, user],
    }),
    false,
  );
  assert.equal(
    isNativeCompactionDetails({ ...identity, compactedWindow: [] }),
    false,
  );
  assert.equal(
    isNativeCompactionDetails({
      ...identity,
      compactedWindow: [
        { type: "message", role: "user", content: [] },
        checkpoint,
      ],
    }),
    false,
  );
  assert.equal(
    isNativeCompactionDetails({
      ...identity,
      compactedWindow: [user, { ...checkpoint, unexpected: true }],
    }),
    false,
  );
  assert.equal(
    isNativeCompactionDetails({
      ...identity,
      compactedWindow: [
        user,
        { ...checkpoint, internal_chat_message_metadata_passthrough: { turn_id: 4 } },
      ],
    }),
    false,
  );
  assert.equal(
    isNativeCompactionDetails({
      ...identity,
      compactedWindow: [checkpoint],
      requestMeta: { tokensBefore: 1, unexpected: true },
    }),
    false,
  );
  assert.throws(
    () => createNativeCompactionDetails({
      provider: identity.provider,
      api: identity.api,
      model: identity.model,
      baseUrl: identity.baseUrl,
      compactedWindow: [],
    }),
    /failed persistence validation/,
  );
});

test("corrupt native-looking checkpoints remain fail-closed", () => {
  assert.equal(
    isNativeLookingCompactionEntry({
      type: "compaction",
      summary: "[OpenAI native compaction checkpoint]",
      details: { strategy: "openai-responses-compaction-v2" },
    }),
    true,
  );
  assert.equal(
    isNativeLookingCompactionEntry({
      type: "compaction",
      summary: "[OpenAI native compaction checkpoint]\n\nReadable prior summary",
    }),
    true,
  );
});

test("fallback lookup never resurrects an older native checkpoint", () => {
  const native = {
    type: "compaction",
    id: "native",
    summary: "[OpenAI native compaction checkpoint]",
    details: {
      strategy: "openai-responses-compaction-v2",
      provider: model.provider,
      api: model.api,
      model: model.id,
      baseUrl: model.baseUrl,
      createdAt: new Date().toISOString(),
      compactedWindow: [{ type: "compaction", encrypted_content: "sealed" }],
    },
  };
  const newerPi = { type: "compaction", id: "pi", summary: "Pi summary" };
  const resolution = resolveLatestNativeCompactionEntry([native, newerPi]);
  assert.equal(resolution.ok, false);
  assert.equal(resolution.reason, "latest-compaction-not-native");
  assert.equal(resolution.latestCompaction?.id, "pi");

  const crossModel = resolveLatestNativeCompactionEntry([native], {
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
  });
  assert.equal(crossModel.ok, true);
  assert.equal(crossModel.entry?.id, "native");
});

test("stored checkpoint bodies force the remote compaction feature header", () => {
  const body = {
    model: model.id,
    input: [{ type: "compaction", encrypted_content: "sealed" }],
  };
  assert.equal(requestBodyUsesRemoteCompactionV2(body), true);
  const options = withRemoteCompactionV2ForBody(
    { headers: { "x-codex-beta-features": "existing" } },
    body,
  );
  assert.equal(
    options.headers["x-codex-beta-features"],
    "existing,remote_compaction_v2",
  );
});

test("oversized retained user message is omitted from native checkpoint window", () => {
  const huge = {
    role: "user",
    content: [{ type: "input_text", text: "x".repeat(10_000) }],
  };
  const checkpoint = { type: "compaction", encrypted_content: "sealed" };
  assert.deepEqual(buildRemoteCompactionV2Window([huge], checkpoint, 10), [
    checkpoint,
  ]);
});

test("native replay accepts exact Pi projection and rejects arbitrary mismatch", () => {
  const userMessage = {
    role: "user",
    content: [{ type: "text", text: "before" }],
    timestamp: 1,
  };
  const tailMessage = {
    role: "user",
    content: [{ type: "text", text: "after" }],
    timestamp: 3,
  };
  const nativeEntry = {
    type: "compaction",
    id: "c",
    parentId: "u",
    timestamp: new Date(2).toISOString(),
    summary: "readable fallback",
    firstKeptEntryId: "u",
    tokensBefore: 100,
    details: {
      strategy: "openai-responses-compaction-v2",
      provider: model.provider,
      api: model.api,
      model: model.id,
      baseUrl: model.baseUrl,
      createdAt: new Date(2).toISOString(),
      compactedWindow: [
        { type: "compaction", encrypted_content: "sealed" },
      ],
    },
  };
  const branchEntries = [
    { type: "message", id: "u", parentId: null, message: userMessage },
    nativeEntry,
    { type: "message", id: "p", parentId: "c", message: tailMessage },
  ];
  const summaryMessage = {
    role: "compactionSummary",
    summary: nativeEntry.summary,
    tokensBefore: nativeEntry.tokensBefore,
    timestamp: new Date(nativeEntry.timestamp).getTime(),
  };
  const exactInput = serializeMessagesToResponsesInput(model, [
    summaryMessage,
    userMessage,
    tailMessage,
  ]);
  const exact = rewriteResponsesPayloadWithNativeReplay({
    model,
    payload: { model: model.id, instructions: "system", input: exactInput },
    branchEntries,
    compactionEntry: nativeEntry,
  });
  assert.equal(exact.ok, true);
  assert.match(JSON.stringify(exact.ok && exact.rewrittenPayload.input), /sealed/);
  assert.doesNotMatch(
    JSON.stringify(exact.ok && exact.rewrittenPayload.input),
    /before/,
  );

  const mismatched = rewriteResponsesPayloadWithNativeReplay({
    model,
    payload: {
      model: model.id,
      instructions: "system",
      input: [
        { role: "user", content: [{ type: "input_text", text: "wrong" }] },
        ...exactInput,
      ],
    },
    branchEntries,
    compactionEntry: nativeEntry,
  });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.reason, "expected-pi-replay-mismatch");

  const missingKeptProjection = rewriteResponsesPayloadWithNativeReplay({
    model,
    payload: {
      model: model.id,
      instructions: "system",
      input: [
        ...serializeMessagesToResponsesInput(model, [summaryMessage]),
        ...serializeMessagesToResponsesInput(model, [tailMessage]),
      ],
    },
    branchEntries,
    compactionEntry: nativeEntry,
  });
  assert.equal(missingKeptProjection.ok, false);
  assert.equal(missingKeptProjection.reason, "expected-pi-replay-mismatch");

  const newerPiCheckpoint = rewriteResponsesPayloadWithNativeReplay({
    model,
    payload: { model: model.id, instructions: "system", input: exactInput },
    branchEntries: [
      ...branchEntries,
      {
        type: "compaction",
        id: "newer-pi",
        parentId: "p",
        timestamp: new Date(4).toISOString(),
        summary: "newer readable Pi summary",
        firstKeptEntryId: "p",
        tokensBefore: 50,
      },
    ],
    compactionEntry: nativeEntry,
  });
  assert.equal(newerPiCheckpoint.ok, false);
  assert.equal(newerPiCheckpoint.reason, "unexpected-compaction-after-boundary");
});

test("native endpoint rejects a compaction mixed with extra output", async () => {
  const streamSimple = (_model, _context, options) =>
    (async function* () {
      await options.onPayload({ model: model.id, input: [] });
      options.onOutputItemDone({
        type: "compaction_summary",
        encrypted_content: "sealed",
      });
      options.onOutputItemDone({ type: "message", role: "assistant" });
      yield {
        type: "done",
        reason: "stop",
        message: {
          responseId: "response",
          stopReason: "stop",
          usage: {
            input: 10,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
          },
        },
      };
    })();
  const result = await executeRemoteCompactionV2({
    runtime: {
      provider: model.provider,
      api: model.api,
      model: model.id,
      baseUrl: model.baseUrl,
      currentModel: model,
      headers: {},
    },
    modelRegistry: {
      getRegisteredProviderConfig: () => ({
        api: model.api,
        streamSimple,
      }),
    },
    context: { systemPrompt: "system", messages: [] },
    promptInput: [
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ],
    requestOptions: {},
    sessionId: "session",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-output");
});

test("provider payload rewrite errors fail closed", async () => {
  const extension = {
    path: "broken-rewriter",
    handlers: new Map([
      [
        "before_provider_request",
        [async () => {
          throw new Error("rewrite failed");
        }],
      ],
    ]),
  };
  const runner = new ExtensionRunner(
    [extension],
    {},
    process.cwd(),
    {},
    {},
  );
  await assert.rejects(
    runner.emitBeforeProviderRequest({ model: "test" }),
    /rewrite failed/,
  );
});

test("multiple compaction owners cancel instead of overwriting each other", async () => {
  const resultFor = (summary) => ({
    compaction: {
      summary,
      firstKeptEntryId: "entry",
      tokensBefore: 1,
    },
  });
  const extensions = ["one", "two"].map((path) => ({
    path,
    handlers: new Map([
      ["session_before_compact", [async () => resultFor(path)]],
    ]),
  }));
  const runner = new ExtensionRunner(
    extensions,
    {},
    process.cwd(),
    {},
    {},
  );
  const result = await runner.emit({ type: "session_before_compact" });
  assert.deepEqual(result, { cancel: true });
});

test("compaction ownership survives unrelated truthy hook results", async () => {
  const owner = (summary) => ({
    compaction: {
      summary,
      firstKeptEntryId: "entry",
      tokensBefore: 1,
    },
  });
  const extensions = [
    { path: "one", result: owner("one") },
    { path: "observer", result: {} },
    { path: "two", result: owner("two") },
  ].map(({ path, result }) => ({
    path,
    handlers: new Map([
      ["session_before_compact", [async () => result]],
    ]),
  }));
  const runner = new ExtensionRunner(
    extensions,
    {},
    process.cwd(),
    {},
    {},
  );
  assert.deepEqual(
    await runner.emit({ type: "session_before_compact" }),
    { cancel: true },
  );
});
