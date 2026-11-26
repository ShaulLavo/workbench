import { GhosttyRuntime } from "ghostty-webgpu";

let sharedRuntimePromise: Promise<GhosttyRuntime> | null = null;

/**
 * Returns the page-scoped shared `GhosttyRuntime` singleton so every mounted `TerminalView`
 * passes `{ kind: "borrowed", runtime }` without duplicating WASM modules.
 * Clears the cached promise if startup fails so a subsequent mount can retry.
 */
export function getSharedGhosttyRuntime(): Promise<GhosttyRuntime> {
  if (!sharedRuntimePromise) {
    sharedRuntimePromise = GhosttyRuntime.create().catch((error: unknown) => {
      sharedRuntimePromise = null;
      throw error;
    });
  }
  return sharedRuntimePromise;
}

/** Clears the cached shared runtime promise for isolated unit tests. */
export function resetSharedGhosttyRuntimeForTests(): void {
  sharedRuntimePromise = null;
}
