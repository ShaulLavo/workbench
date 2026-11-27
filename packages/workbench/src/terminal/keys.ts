/** Hardware key descriptor dispatched to Ghostty's input textarea so `DECCKM` and shell modes apply. */
export interface TerminalKey {
  readonly id: string;
  readonly label: string;
  readonly key: string;
  readonly code: string;
}

export const TERMINAL_KEYS = {
  escape: { id: "escape", label: "Esc", key: "Escape", code: "Escape" },
  tab: { id: "tab", label: "Tab", key: "Tab", code: "Tab" },
  left: { id: "left", label: "Left", key: "ArrowLeft", code: "ArrowLeft" },
  up: { id: "up", label: "Up", key: "ArrowUp", code: "ArrowUp" },
  down: { id: "down", label: "Down", key: "ArrowDown", code: "ArrowDown" },
  right: { id: "right", label: "Right", key: "ArrowRight", code: "ArrowRight" },
} as const satisfies Record<string, TerminalKey>;

export const SHELL_SYMBOL_KEYS = [
  { id: "pipe", label: "|", text: "|" },
  { id: "tilde", label: "~", text: "~" },
  { id: "slash", label: "/", text: "/" },
  { id: "dash", label: "-", text: "-" },
] as const;

/** Maps a typed ASCII letter (`a-z`) to a hardware `Ctrl+<letter>` key chord, or `null` otherwise. */
export function controlKeyFor(character: string): TerminalKey | null {
  const letter = character.toLowerCase();
  if (!/^[a-z]$/.test(letter)) return null;
  const upper = letter.toUpperCase();
  return {
    id: `ctrl-${letter}`,
    label: `Ctrl+${upper}`,
    key: letter,
    code: `Key${upper}`,
  };
}

/**
 * Dispatches real hardware `keydown` and `keyup` events to Ghostty's hidden `<textarea>` so
 * terminal-encoded modes (`DECCKM` application cursor keys, Ctrl chords, Tab, Escape) work verbatim.
 */
export function dispatchTerminalHardwareKey(
  host: HTMLElement | null,
  key: TerminalKey,
  ctrlKey: boolean,
): boolean {
  const input = host?.querySelector("textarea");
  if (!input) return false;
  const init: KeyboardEventInit = {
    bubbles: true,
    cancelable: true,
    key: key.key,
    code: key.code,
    ctrlKey,
  };
  input.dispatchEvent(new KeyboardEvent("keydown", init));
  input.dispatchEvent(new KeyboardEvent("keyup", init));
  return true;
}
