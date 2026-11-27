import { useEffect, useState, type PointerEvent, type RefObject } from "react";
import { cx } from "../ui/index";
import {
  controlKeyFor,
  dispatchTerminalHardwareKey,
  SHELL_SYMBOL_KEYS,
  TERMINAL_KEYS,
  type TerminalKey,
} from "./keys";

export interface TerminalAccessoryBarProps {
  readonly terminalRef: RefObject<HTMLElement | null>;
  /** Optional raw-text sender for quick shell symbols (`|`, `~`, `/`, `-`). */
  readonly onSendText?: (text: string) => void;
  readonly className?: string;
}

const CTRL_C: TerminalKey = { id: "ctrl-c", label: "^C", key: "c", code: "KeyC" };

const ARROW_KEYS: readonly (readonly [TerminalKey, string])[] = [
  [TERMINAL_KEYS.left, "←"],
  [TERMINAL_KEYS.up, "↑"],
  [TERMINAL_KEYS.down, "↓"],
  [TERMINAL_KEYS.right, "→"],
];

function keepTerminalFocus(event: PointerEvent<HTMLButtonElement>): void {
  // Never blur Ghostty's textarea or collapse the iOS soft keyboard when tapping a key button.
  event.preventDefault();
}

/**
 * Mobile hardware-key accessory bar for Ghostty terminals.
 * Sends real `KeyboardEvent` keydown/keyup events for Esc, Tab, ^C, sticky Ctrl, and arrows so
 * `DECCKM` application cursor modes work in vim, less, and fzf, with an Android IME cancelable guard.
 */
export function TerminalAccessoryBar({ terminalRef, onSendText, className }: TerminalAccessoryBarProps) {
  const [ctrlArmed, setCtrlArmed] = useState(false);

  useEffect(() => {
    const host = terminalRef.current;
    if (!host || !ctrlArmed) return;

    const onBeforeInput = (event: InputEvent): void => {
      const chord = event.data ? controlKeyFor(event.data) : null;
      // Composing Android IME inputs cannot be cancelled; let them commit as plain text.
      if (!chord || !event.cancelable) return;
      event.preventDefault();
      setCtrlArmed(false);
      dispatchTerminalHardwareKey(host, chord, true);
    };

    host.addEventListener("beforeinput", onBeforeInput, { capture: true });
    return () => {
      host.removeEventListener("beforeinput", onBeforeInput, { capture: true });
    };
  }, [ctrlArmed, terminalRef]);

  function pressKey(key: TerminalKey, forceCtrl = false): void {
    dispatchTerminalHardwareKey(terminalRef.current, key, forceCtrl || ctrlArmed);
    if (!forceCtrl && ctrlArmed) setCtrlArmed(false);
  }

  function insertSymbol(text: string): void {
    if (ctrlArmed) setCtrlArmed(false);
    if (onSendText) {
      onSendText(text);
      return;
    }
    const input = terminalRef.current?.querySelector("textarea");
    if (!input) return;
    input.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: text,
        inputType: "insertText",
      }),
    );
  }

  return (
    <div
      role="toolbar"
      aria-label="Terminal keys"
      data-wb-terminal-accessory-bar=""
      className={cx("wb-terminal-accessory-bar", className)}
    >
      <button
        type="button"
        className="wb-terminal-key"
        data-testid="wb-term-key-esc"
        onPointerDown={keepTerminalFocus}
        onClick={() => pressKey(TERMINAL_KEYS.escape)}
      >
        Esc
      </button>
      <button
        type="button"
        className="wb-terminal-key"
        data-testid="wb-term-key-tab"
        onPointerDown={keepTerminalFocus}
        onClick={() => pressKey(TERMINAL_KEYS.tab)}
      >
        Tab
      </button>
      <button
        type="button"
        className="wb-terminal-key"
        data-testid="wb-term-key-ctrl"
        aria-pressed={ctrlArmed}
        data-active={ctrlArmed ? "true" : undefined}
        onPointerDown={keepTerminalFocus}
        onClick={() => setCtrlArmed((armed) => !armed)}
      >
        Ctrl
      </button>
      <button
        type="button"
        className="wb-terminal-key"
        data-testid="wb-term-key-ctrl-c"
        aria-label="Interrupt (Ctrl+C)"
        onPointerDown={keepTerminalFocus}
        onClick={() => pressKey(CTRL_C, true)}
      >
        ^C
      </button>

      <span className="wb-terminal-key-group" aria-label="Shell symbols">
        {SHELL_SYMBOL_KEYS.map((sym) => (
          <button
            key={sym.id}
            type="button"
            className="wb-terminal-key"
            data-testid={`wb-term-key-${sym.id}`}
            onPointerDown={keepTerminalFocus}
            onClick={() => insertSymbol(sym.text)}
          >
            {sym.label}
          </button>
        ))}
      </span>

      <span className="wb-terminal-key-arrows" aria-label="Arrow keys">
        {ARROW_KEYS.map(([key, glyph]) => (
          <button
            key={key.id}
            type="button"
            className="wb-terminal-key"
            aria-label={key.label}
            data-testid={`wb-term-key-${key.id}`}
            onPointerDown={keepTerminalFocus}
            onClick={() => pressKey(key)}
          >
            {glyph}
          </button>
        ))}
      </span>
    </div>
  );
}
