import type { TerminalSavedScroll } from "./adapters/terminal";

export type ReplayGatePhase = "replaying" | "awaiting-paint" | "ready" | "closed";

export interface ReplayGateTerminal {
  scrollBy(deltaLines: number): void;
  refresh(startRow: number, endRow: number): void;
  getRowCount(): number;
}

export interface ReplayGate {
  readonly phase: () => ReplayGatePhase;
  begin(): void;
  complete(): void;
  paint(): void;
  close(): void;
}

/**
 * Ordered terminal replay gate matching Fregat's `ready -> output -> replay-complete -> paint`
 * contract: restores saved scroll position once on first replay completion and enables user input
 * only after the first painted frame lands.
 */
export function createReplayGate(options: {
  readonly terminal: ReplayGateTerminal;
  readonly getSavedScroll: () => TerminalSavedScroll | null;
  readonly onReadyChange: (ready: boolean) => void;
}): ReplayGate {
  let phase: ReplayGatePhase = "replaying";
  let restoreScroll = true;

  return {
    phase: () => phase,
    begin() {
      if (phase === "closed") return;
      phase = "replaying";
      options.onReadyChange(false);
    },
    complete() {
      if (phase !== "replaying") return;
      const saved = restoreScroll ? options.getSavedScroll() : null;
      restoreScroll = false;
      if (saved) {
        options.terminal.scrollBy(-Math.max(0, saved.total - saved.length - saved.offset));
      }
      phase = "awaiting-paint";
      const rows = options.terminal.getRowCount();
      if (rows > 0) options.terminal.refresh(0, rows - 1);
    },
    paint() {
      if (phase !== "awaiting-paint") return;
      phase = "ready";
      options.onReadyChange(true);
    },
    close() {
      if (phase === "closed") return;
      phase = "closed";
      options.onReadyChange(false);
    },
  };
}
