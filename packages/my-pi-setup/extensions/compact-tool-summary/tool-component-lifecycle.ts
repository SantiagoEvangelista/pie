export type RestorePatch = () => void;
export type InstallPatch = () => Promise<RestorePatch | undefined>;

export interface PatchLifecycle {
  start(mode: string): Promise<void>;
  stop(): void;
}

/**
 * Owns one session's global ToolExecutionComponent patch.
 *
 * Headless workflow/subagent sessions load this extension in-process too. They
 * must not touch the shared TUI prototype or their shutdown would restore over
 * the interactive parent's patch.
 */
export function createPatchLifecycle(install: InstallPatch): PatchLifecycle {
  let restore: RestorePatch | undefined;

  return {
    async start(mode: string): Promise<void> {
      restore?.();
      restore = undefined;
      if (mode !== "tui") return;
      restore = await install();
    },

    stop(): void {
      restore?.();
      restore = undefined;
    },
  };
}
