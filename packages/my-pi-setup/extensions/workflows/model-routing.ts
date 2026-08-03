import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_DELEGATED_MODEL_ID,
  DEFAULT_DELEGATED_PROVIDER,
} from "../shared/intelligence-tiering.ts";
import type { WorkflowModel } from "./runner.ts";

type ModelRegistry = Pick<ExtensionContext["modelRegistry"], "find" | "getAll">;

export type WorkflowModelResolution =
  | { model: WorkflowModel; error?: never }
  | { model?: never; error: string };

/** Resolve explicit workflow routing or select the worker-tier default. */
export function resolveWorkflowModel(
  registry: ModelRegistry,
  modelValue: unknown,
  providerValue: unknown,
): WorkflowModelResolution {
  if (
    modelValue !== undefined &&
    (typeof modelValue !== "string" || !modelValue.trim())
  ) {
    return { error: "`model` must be a non-empty string" };
  }
  if (
    providerValue !== undefined &&
    (typeof providerValue !== "string" || !providerValue.trim())
  ) {
    return { error: "`provider` must be a non-empty string" };
  }

  const model = modelValue as string | undefined;
  const provider = providerValue as string | undefined;

  if (!model && provider) {
    return { error: "`provider` requires `model` as well" };
  }

  if (!model) {
    const worker = registry.find(
      DEFAULT_DELEGATED_PROVIDER,
      DEFAULT_DELEGATED_MODEL_ID,
    );
    return worker
      ? { model: worker }
      : {
          error: `default delegated model "${DEFAULT_DELEGATED_PROVIDER}/${DEFAULT_DELEGATED_MODEL_ID}" is unavailable`,
        };
  }

  let resolved: WorkflowModel | undefined;
  if (provider) {
    resolved = registry.find(provider, model);
  } else {
    const slash = model.indexOf("/");
    if (slash > 0) {
      resolved = registry.find(model.slice(0, slash), model.slice(slash + 1));
    } else {
      const matches = registry.getAll().filter((candidate) => candidate.id === model);
      if (matches.length > 1) {
        return {
          error: `model "${model}" exists in multiple providers; use provider/id`,
        };
      }
      resolved = matches[0];
    }
  }

  if (resolved) return { model: resolved };

  const requested = provider ? `${provider}/${model}` : model;
  return { error: `unknown model "${requested}" (use provider/id)` };
}
