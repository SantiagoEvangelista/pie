const SGR = /\x1b\[([0-9;]*)m/g;

export function applyPersistentBackground(
  lines: readonly string[],
  background: string,
): string[] {
  return lines.map((line) => {
    const persistent = line.replace(SGR, (sequence, parameters: string) => {
      const codes = parameters === "" ? [0] : parameters.split(";").map(Number);
      return codes.includes(0) || codes.includes(49)
        ? `${sequence}${background}`
        : sequence;
    });
    return `${background}${persistent}\x1b[49m`;
  });
}

export interface ActionLabelTheme {
  fg(color: "text", text: string): string;
  bold(text: string): string;
}

export function renderFocusedActionLabel(
  theme: ActionLabelTheme,
  text: string,
): string {
  return theme.bold(theme.fg("text", text));
}
