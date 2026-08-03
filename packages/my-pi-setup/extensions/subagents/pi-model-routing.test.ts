import assert from "node:assert/strict";
import test from "node:test";
import { resolvePiModel } from "./src/pi-model-routing.ts";

type Registry = Parameters<typeof resolvePiModel>[0];

const specialist = {
  provider: "specialist-provider",
  id: "specialist-model",
};
const sol = { provider: "openai-codex", id: "gpt-5.6-sol" };
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

test("omitted direct-subagent model resolves Sol", () => {
  const model = resolvePiModel(registry, undefined, sol);

  assert.equal(model?.provider, sol.provider);
  assert.equal(model?.id, sol.id);
});

test("explicit direct-subagent Sol remains selectable", () => {
  const qualified = resolvePiModel(
    registry,
    "openai-codex/gpt-5.6-sol",
    sol,
  );
  const bare = resolvePiModel(registry, "gpt-5.6-sol", sol);

  assert.deepEqual(
    { provider: qualified.provider, id: qualified.id },
    sol,
  );
  assert.deepEqual({ provider: bare.provider, id: bare.id }, sol);
});

test("missing default direct-subagent worker fails closed", () => {
  const emptyRegistry = {
    find() {
      return undefined;
    },
    getAll() {
      return [];
    },
  } as unknown as Registry;

  assert.throws(
    () => resolvePiModel(emptyRegistry, undefined, sol),
    /Default delegated model.*gpt-5\.6-sol.*unavailable/,
  );
});

test("blank direct-subagent model hint fails instead of inheriting", () => {
  assert.throws(
    () => resolvePiModel(registry, "", sol),
    /Model hint must be a non-empty string/,
  );
});
