import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_DELEGATED_MODEL_ID,
  DEFAULT_DELEGATED_PROVIDER,
} from "../../shared/intelligence-tiering.ts";

/**
 * Resolve an exact provider/model hint, a bare model ID, or worker default.
 * Bare IDs prefer parent provider only to disambiguate an explicit request;
 * omission never inherits parent orchestrator.
 */
export function resolvePiModel(
  registry: ModelRegistry,
  hint: string | undefined,
  inherited: { provider: string; id: string } | undefined,
): Model<any> {
  if (hint === undefined) {
    const worker = registry.find(
      DEFAULT_DELEGATED_PROVIDER,
      DEFAULT_DELEGATED_MODEL_ID,
    );
    if (worker) return worker;
    throw new Error(
      `Default delegated model "${DEFAULT_DELEGATED_PROVIDER}/${DEFAULT_DELEGATED_MODEL_ID}" is unavailable.`,
    );
  }
  if (!hint.trim()) throw new Error("Model hint must be a non-empty string.");
  const slash = hint.indexOf("/");
  if (slash > 0) {
    const provider = hint.slice(0, slash);
    const id = hint.slice(slash + 1);
    const found = registry.find(provider, id);
    if (found) return found;
    throw new Error(`Unknown model "${hint}".`);
  }
  if (inherited) {
    const found = registry.find(inherited.provider, hint);
    if (found) return found;
  }
  const matches = registry.getAll().filter((model) => model.id === hint);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(
      `Model "${hint}" exists in multiple providers (${matches.map((model) => model.provider).join(", ")}). Use "provider/${hint}".`,
    );
  }
  throw new Error(`Unknown model "${hint}".`);
}
