/** Resolve workflow execution mode without detaching work in headless sessions. */
export function resolveWorkflowBackground(
  requested: boolean | undefined,
  hasUI: boolean,
): boolean {
  return (requested ?? true) && hasUI;
}
