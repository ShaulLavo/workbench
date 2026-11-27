import type { ActivationFocusDecision } from "../focus-policy.js";
import type { Subscribable } from "../subscribable.js";

export interface LspLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

export interface LspServerStatus {
  readonly state: "idle" | "starting" | "ready" | "restarting" | "error";
  readonly label?: string;
  readonly errorCount: number;
  readonly warningCount: number;
}

/**
 * Backend-neutral LSP host contract in `@shaulavo/workbench-core` (zero Singapore dependency).
 * Typed Singapore transport creation lives in `@shaulavo/workbench-editor/lsp`.
 */
export interface LspHostAdapter {
  readonly status: Subscribable<LspServerStatus>;
  pathToUri(path: string): string;
  uriToPath(uri: string): string | null;
  openLocation(location: LspLocation, focus: ActivationFocusDecision): boolean;
  onConnected?(languageId: string): void;
  dispose?(): void;
}
