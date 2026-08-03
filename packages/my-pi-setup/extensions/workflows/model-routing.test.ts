import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkflowModel } from "./model-routing.ts";

type Registry = Parameters<typeof resolveWorkflowModel>[0];

const specialist = {
  provider: "specialist-provider",
  id: "specialist-model",
  contextWindow: 1_048_576,
};
const sol = {
  provider: "openai-codex",
  id: "gpt-5.6-sol",
  contextWindow: 272_000,
};
const models = [specialist, sol];
const registry = {
  find(provider: string, id: string) {
    return models.find(
      (model) => model.provider === provider && model.id === id,
    );
  },
  getAll() {
    return models;
  },
} as unknown as Registry;

test("omitted workflow model resolves Sol", () => {
  const result = resolveWorkflowModel(registry, undefined, undefined);

  assert.equal(result.error, undefined);
  assert.equal(result.model?.provider, sol.provider);
  assert.equal(result.model?.id, sol.id);
});

test("explicit Sol resolves with separate or combined provider syntax", () => {
  const separate = resolveWorkflowModel(
    registry,
    "gpt-5.6-sol",
    "openai-codex",
  );
  const combined = resolveWorkflowModel(
    registry, "openai-codex/gpt-5.6-sol", undefined,
  );

  assert.deepEqual(
    { provider: separate.model?.provider, id: separate.model?.id },
    { provider: sol.provider, id: sol.id },
  );
  assert.deepEqual(
    { provider: combined.model?.provider, id: combined.model?.id },
    { provider: sol.provider, id: sol.id },
  );
});

test("bare duplicate IDs and failed qualified IDs fail closed", () => {
  const duplicateSpecialist = {
    provider: "another-provider",
    id: "specialist-model",
    contextWindow: 1_048_576,
  };
  const misleadingQualifiedId = {
    provider: "another-provider",
    id: "missing-provider/missing-model",
    contextWindow: 272_000,
  };
  const ambiguousRegistry = {
    find(provider: string, id: string) {
      return [...models, duplicateSpecialist, misleadingQualifiedId].find(
        (candidate) =>
          candidate.provider === provider && candidate.id === id,
      );
    },
    getAll() {
      return [...models, duplicateSpecialist, misleadingQualifiedId];
    },
  } as unknown as Registry;

  assert.match(
    resolveWorkflowModel(ambiguousRegistry, "specialist-model", undefined)
      .error ?? "",
    /multiple providers/,
  );
  assert.match(
    resolveWorkflowModel(
      ambiguousRegistry,
      "missing-provider/missing-model",
      undefined,
    ).error ?? "",
    /unknown model/,
  );
});

test("invalid routing returns bounded errors", () => {
  assert.match(
    resolveWorkflowModel(registry, 42, undefined).error ?? "",
    /model.*non-empty string/,
  );
  assert.match(
    resolveWorkflowModel(registry, "specialist-model", "").error ?? "",
    /provider.*non-empty string/,
  );
  assert.match(
    resolveWorkflowModel(registry, undefined, "openai-codex").error ?? "",
    /provider.*requires.*model/,
  );
  assert.match(
    resolveWorkflowModel(registry, "missing", undefined).error ?? "",
    /unknown model "missing"/,
  );

  const emptyRegistry = {
    find() {
      return undefined;
    },
    getAll() {
      return [];
    },
  } as unknown as Registry;
  assert.match(
    resolveWorkflowModel(emptyRegistry, undefined, undefined).error ?? "",
    /default delegated model.*gpt-5\.6-sol.*unavailable/,
  );
});
