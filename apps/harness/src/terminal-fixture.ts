import type {
  Subscribable,
  TerminalAdapter,
  TerminalSavedScroll,
  TerminalSessionInfo,
  TerminalStreamEvent,
} from "@shaulavo/workbench/core";
import type { TerminalThemeInput } from "@shaulavo/workbench/terminal";

function createSubscribable<T>(initial: T): Subscribable<T> & { set(next: T): void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: T) {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

export interface HarnessTerminalBundle {
  readonly adapter: TerminalAdapter;
  readonly stats: Subscribable<{
    readonly lastInput: string;
    readonly detachCount: number;
    readonly closeCount: number;
  }>;
  enableDecckm(sessionId: string): void;
  readonly transparentOverride: Subscribable<TerminalThemeInput>;
}

const FREGAT_TRANSPARENT_PALETTE: TerminalThemeInput = {
  colorScheme: "dark",
  background: { r: 18, g: 18, b: 17 },
  foreground: { r: 235, g: 235, b: 230 },
  cursor: { r: 235, g: 235, b: 230 },
  cursorAccent: { r: 28, g: 28, b: 26 },
  selectionBackground: { r: 58, g: 72, b: 96 },
  selectionForeground: { r: 255, g: 255, b: 255 },
  backgroundOpacity: 0,
  ansi: [
    { r: 24, g: 24, b: 27 },
    { r: 239, g: 68, b: 68 },
    { r: 34, g: 197, b: 94 },
    { r: 234, g: 179, b: 8 },
    { r: 59, g: 130, b: 246 },
    { r: 168, g: 85, b: 247 },
    { r: 6, g: 182, b: 212 },
    { r: 228, g: 228, b: 231 },
    { r: 82, g: 82, b: 91 },
    { r: 248, g: 113, b: 113 },
    { r: 74, g: 222, b: 128 },
    { r: 250, g: 204, b: 21 },
    { r: 96, g: 165, b: 250 },
    { r: 192, g: 132, b: 252 },
    { r: 34, g: 211, b: 238 },
    { r: 250, g: 250, b: 250 },
  ],
};

function encodeControlPreview(raw: string): string {
  return raw.replaceAll("\u001b", "<ESC>").replaceAll("\r", "<CR>").replaceAll("\n", "<LF>");
}

/** Interactive in-memory `TerminalAdapter` exercising ordered replay, DECCKM, split, and detach vs close. */
export function createHarnessTerminalBundle(onOpenFileLink?: (path: string) => void): HarnessTerminalBundle {
  let nextSeq = 3;
  const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
    { id: "bash-1", title: "bash", status: "running", cwd: "/workspace" },
    { id: "logs-2", title: "dev server", status: "running", cwd: "/workspace" },
  ]);
  const activeId = createSubscribable<string | undefined>("bash-1");
  const splitId = createSubscribable<string | undefined>(undefined);
  const stats = createSubscribable({ lastInput: "", detachCount: 0, closeCount: 0 });
  const transparentOverride = createSubscribable<TerminalThemeInput>(FREGAT_TRANSPARENT_PALETTE);
  const savedScrolls = new Map<string, TerminalSavedScroll>();
  const activeStreams = new Map<string, (event: TerminalStreamEvent) => void>();

  const adapter: TerminalAdapter = {
    sessions,
    activeId,
    splitId,
    async createSession(options) {
      const id = `term-${nextSeq}`;
      nextSeq += 1;
      const title = options?.title ?? `shell ${nextSeq - 1}`;
      sessions.set(sessions.getSnapshot().concat([{ id, title, status: "running" }]));
      activeId.set(id);
      return id;
    },
    async closeSession(id) {
      const current = stats.getSnapshot();
      stats.set({ ...current, closeCount: current.closeCount + 1 });
      const remaining = sessions.getSnapshot().filter((s) => s.id !== id);
      sessions.set(remaining);
      if (splitId.getSnapshot() === id) splitId.set(undefined);
      if (activeId.getSnapshot() === id) activeId.set(remaining[0]?.id);
    },
    selectSession(id) {
      if (id === activeId.getSnapshot() || id === splitId.getSnapshot()) return;
      splitId.set(undefined);
      activeId.set(id);
    },
    renameSession(id, title) {
      sessions.set(sessions.getSnapshot().map((s) => (s.id === id ? { ...s, title } : s)));
    },
    toggleSplit() {
      const currentSplit = splitId.getSnapshot();
      if (currentSplit) {
        splitId.set(undefined);
        return;
      }
      const primary = activeId.getSnapshot();
      const other = sessions.getSnapshot().find((s) => s.id !== primary);
      if (other) splitId.set(other.id);
    },
    async attach(id, { signal, onEvent }) {
      activeStreams.set(id, onEvent);
      let detached = false;
      const emit = (event: TerminalStreamEvent): void => {
        if (!detached && !signal.aborted) onEvent(event);
      };

      // Deliver ordered ready -> replay chunks -> replay-complete sequence.
      queueMicrotask(() => {
        emit({ type: "ready" });
        emit({
          type: "output",
          data: `\x1b[32m${id}\x1b[0m $ bun run verify\r\nReady: src/features/editor/App.tsx:12:4\r\n$ `,
        });
        emit({ type: "replay-complete" });
      });

      return {
        write(data) {
          if (detached) return;
          const prev = stats.getSnapshot();
          stats.set({ ...prev, lastInput: encodeControlPreview(data) });
          emit({ type: "output", data });
        },
        resize() {},
        detach() {
          if (detached) return;
          detached = true;
          if (activeStreams.get(id) === onEvent) activeStreams.delete(id);
          const prev = stats.getSnapshot();
          stats.set({ ...prev, detachCount: prev.detachCount + 1 });
        },
      };
    },
    getSavedScroll: (id) => savedScrolls.get(id) ?? null,
    saveScroll(id, scroll) {
      savedScrolls.set(id, scroll);
    },
    async resolveFileLink(rawPath) {
      return rawPath;
    },
    openFileLink(path) {
      onOpenFileLink?.(path);
    },
  };

  return {
    adapter,
    stats,
    enableDecckm(sessionId: string) {
      const stream = activeStreams.get(sessionId);
      // Enable DECCKM application cursor keys mode so Up Arrow sends ESC O A instead of ESC [ A.
      stream?.({ type: "output", data: "\x1b[?1h" });
    },
    transparentOverride,
  };
}
