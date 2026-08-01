/** Harness-only mode. Providers and child sessions receive ordinary xhigh. */
export const ULTRACODE_THINKING_LEVEL = "ultracode";

export function isUltracodeThinkingLevel(level: unknown): boolean {
  return level === ULTRACODE_THINKING_LEVEL;
}

export function toProviderThinkingLevel(
  level: string | undefined,
): string | undefined {
  return isUltracodeThinkingLevel(level) ? "xhigh" : level;
}
