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
