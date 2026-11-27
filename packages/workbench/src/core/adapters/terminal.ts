import type { ActivationFocusDecision } from "../focus-policy.js";
import type { Subscribable } from "../subscribable.js";

export type TerminalSessionStatus = "starting" | "ready" | "running" | "exited" | "failed" | "disconnected";

export interface TerminalSessionInfo {
  readonly id: string;
  readonly title: string;
  readonly status: TerminalSessionStatus;
  readonly exitCode?: number | null;
  readonly processName?: string | null;
  readonly cwd?: string;
}

export interface TerminalSavedScroll {
  readonly total: number;
  readonly length: number;
  readonly offset: number;
}

/** Ordered wire events for one terminal attachment. Replay chunks arrive between `ready` and `replay-complete`. */
export type TerminalStreamEvent =
  | { readonly type: "ready"; readonly restoredHistory?: boolean }
  | { readonly type: "output"; readonly data: string | Uint8Array }
  | { readonly type: "replay-complete" }
  | { readonly type: "cleared" }
  | { readonly type: "process"; readonly name: string | null }
  | { readonly type: "title"; readonly title: string }
  | { readonly type: "exit"; readonly exitCode: number | null }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "disconnected"; readonly willReconnect: boolean };

export interface TerminalAttachment {
  write(data: string): void;
  /** Optional raw-byte input path preserving non-UTF-8 or binary terminal input without re-encoding. */
  writeBytes?(bytes: Uint8Array): void;
  resize(cols: number, rows: number): void;
  /** Optional hook called after Ghostty paints a frame (for flow control or viewport snapshots). */
  markRendered?(): void;
  /**
   * Detaches this view from the live stream without killing the underlying PTY process.
   * Called on React unmount, tab switch, or pane collapse.
   */
  detach(): void;
}

export interface TerminalAttachOptions {
  readonly initialSize: { readonly cols: number; readonly rows: number };
  readonly signal: AbortSignal;
  readonly onEvent: (event: TerminalStreamEvent) => void;
}

export interface TerminalAdapter {
  readonly sessions: Subscribable<readonly TerminalSessionInfo[]>;
  readonly activeId: Subscribable<string | undefined>;
  readonly splitId: Subscribable<string | undefined>;
  /** Optional authoritative `[leftId, rightId]` split pair for adapters that track focus separately from split membership. */
  readonly splitPair?: Subscribable<readonly [leftId: string, rightId: string] | undefined>;

  createSession(options?: { readonly title?: string; readonly cwd?: string }): Promise<string>;
  /** Explicit user kill: terminates the PTY process and removes the session. */
  closeSession(id: string): Promise<void>;
  selectSession(id: string): void;
  renameSession(id: string, title: string): void;
  toggleSplit(id?: string): void;

  /**
   * Attaches a mounted TerminalView to a session and delivers ordered TerminalStreamEvents.
   * Backends without server-side replay emit `ready` then `replay-complete` immediately.
   */
  attach(id: string, options: TerminalAttachOptions): Promise<TerminalAttachment>;

  getSavedScroll?(id: string): TerminalSavedScroll | null;
  saveScroll?(id: string, scroll: TerminalSavedScroll): void;

  resolveFileLink?(rawPath: string): Promise<string | null>;
  openFileLink?(
    path: string,
    location: { readonly line?: number; readonly column?: number } | undefined,
    focus: ActivationFocusDecision,
  ): void;
  openExternalUrl?(url: string): void;
}
