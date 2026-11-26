import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Subscribable, TerminalAdapter, TerminalSessionInfo } from "@shaulavo/workbench-core";
import { WorkbenchPortalProvider } from "@shaulavo/workbench-ui";
import type { TerminalTheme } from "ghostty-webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGhosttyTheme,
  controlKeyFor,
  findTerminalSnapshotFileLinks,
  parseTerminalFileReference,
  TerminalAccessoryBar,
  terminalCursorOptions,
  TerminalPanel,
} from "../index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let activeRoot: Root | null = null;
let activeHost: HTMLDivElement | null = null;

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

function mount(element: React.ReactElement): HTMLDivElement {
  activeHost = document.createElement("div");
  document.body.appendChild(activeHost);
  activeRoot = createRoot(activeHost);
  act(() => {
    activeRoot?.render(<WorkbenchPortalProvider>{element}</WorkbenchPortalProvider>);
  });
  return activeHost;
}

afterEach(() => {
  act(() => {
    activeRoot?.unmount();
  });
  activeRoot = null;
  activeHost?.remove();
  activeHost = null;
});

function makeBaseTheme(): TerminalTheme {
  return {
    background: { r: 0, g: 0, b: 0 },
    foreground: { r: 255, g: 255, b: 255 },
    cursor: { r: 255, g: 255, b: 255 },
    selectionBackground: { r: 40, g: 80, b: 140 },
    selectionForeground: { r: 255, g: 255, b: 255 },
    minimumContrast: 1,
    palette: Array.from({ length: 256 }, (_, i) => ({ r: i, g: i, b: i })),
  };
}

describe("@shaulavo/workbench-terminal", () => {
  it("projects opaque Sprockt colors and transparent Fregat cursorAccent backgrounds", () => {
    const base = makeBaseTheme();
    const colors = {
      background: { r: 255, g: 255, b: 255 },
      foreground: { r: 17, g: 17, b: 17 },
      cursor: { r: 26, g: 75, b: 224 },
      cursorAccent: { r: 250, g: 245, b: 240 },
      selectionBackground: { r: 207, g: 224, b: 255 },
      selectionForeground: { r: 17, g: 17, b: 17 },
      ansi: Array.from({ length: 16 }, (_, i) => ({ r: i * 10, g: 20, b: 30 })),
    };

    const opaque = buildGhosttyTheme(colors, base, { transparent: false });
    expect(opaque.background).toEqual({ r: 255, g: 255, b: 255 });
    expect(opaque.selectionForeground).toEqual({ r: 17, g: 17, b: 17 });
    expect(opaque.palette[0]).toEqual({ r: 0, g: 20, b: 30 });
    expect(opaque.palette[15]).toEqual({ r: 150, g: 20, b: 30 });
    expect(opaque.palette[16]).toEqual({ r: 16, g: 16, b: 16 });

    const transparent = buildGhosttyTheme(colors, base, { transparent: true });
    expect(transparent.background).toEqual({ r: 250, g: 245, b: 240 });

    expect(terminalCursorOptions(true, true)).toEqual({ style: "block", blink: true });
    expect(terminalCursorOptions(false, true)).toEqual({ style: "outline", blink: false });
  });

  it("parses workspace file:line:col links while rejecting URLs, hostnames, and version banners", () => {
    expect(parseTerminalFileReference("src/App.tsx:42:7")).toEqual({
      path: "src/App.tsx",
      line: 42,
      column: 7,
    });
    expect(parseTerminalFileReference("ERROR:packages/core/index.ts:12.")).toEqual({
      path: "packages/core/index.ts",
      line: 12,
    });
    expect(parseTerminalFileReference("https://example.com/src/App.tsx")).toBeNull();
    expect(parseTerminalFileReference("Mozilla/5.0")).toBeNull();
    expect(parseTerminalFileReference("example.com:8080")).toBeNull();

    const text = "at render (src/App.tsx:18:5) and https://example.com/a.ts";
    const snapshot = {
      text,
      startCellByTextBoundary: Array.from({ length: text.length + 1 }, (_, i) => i),
      endCellByTextBoundary: Array.from({ length: text.length + 1 }, (_, i) => Math.max(0, i - 1)),
    };
    const links = findTerminalSnapshotFileLinks(snapshot);
    expect(links).toHaveLength(1);
    expect(links[0]?.reference).toEqual({ path: "src/App.tsx", line: 18, column: 5 });
  });

  it("dispatches hardware KeyboardEvents, sticky Ctrl with cancelable IME guard, and shell symbols", () => {
    expect(controlKeyFor("c")).toEqual({ id: "ctrl-c", label: "Ctrl+C", key: "c", code: "KeyC" });
    expect(controlKeyFor("1")).toBeNull();

    const receivedKeys: {
      readonly type: string;
      readonly key: string;
      readonly code: string;
      readonly ctrlKey: boolean;
    }[] = [];
    const onSendText = vi.fn();

    function AccessoryHarness() {
      const ref = useRef<HTMLDivElement | null>(null);
      return (
        <div>
          <div ref={ref}>
            <textarea
              data-testid="mock-ghostty-textarea"
              onKeyDown={(e) =>
                receivedKeys.push({ type: "keydown", key: e.key, code: e.code, ctrlKey: e.ctrlKey })
              }
              onKeyUp={(e) =>
                receivedKeys.push({ type: "keyup", key: e.key, code: e.code, ctrlKey: e.ctrlKey })
              }
            />
          </div>
          <TerminalAccessoryBar terminalRef={ref} onSendText={onSendText} />
        </div>
      );
    }

    const host = mount(<AccessoryHarness />);
    const textarea = host.querySelector<HTMLTextAreaElement>('[data-testid="mock-ghostty-textarea"]');
    expect(textarea).not.toBeNull();

    // Pointerdown prevents default so focus never leaves Ghostty's textarea.
    const escBtn = host.querySelector<HTMLButtonElement>('[data-testid="wb-term-key-esc"]');
    const pdEvent = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
    act(() => {
      escBtn?.dispatchEvent(pdEvent);
    });
    expect(pdEvent.defaultPrevented).toBe(true);

    act(() => {
      escBtn?.click();
      host.querySelector<HTMLButtonElement>('[data-testid="wb-term-key-up"]')?.click();
    });
    expect(receivedKeys).toContainEqual({
      type: "keydown",
      key: "Escape",
      code: "Escape",
      ctrlKey: false,
    });
    expect(receivedKeys).toContainEqual({
      type: "keydown",
      key: "ArrowUp",
      code: "ArrowUp",
      ctrlKey: false,
    });

    // Arm sticky Ctrl: non-cancelable Android IME input is ignored; cancelable input dispatches Ctrl+L.
    const ctrlBtn = host.querySelector<HTMLButtonElement>('[data-testid="wb-term-key-ctrl"]');
    act(() => {
      ctrlBtn?.click();
    });
    expect(ctrlBtn?.getAttribute("aria-pressed")).toBe("true");

    act(() => {
      textarea?.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: false, data: "k" }));
    });
    expect(ctrlBtn?.getAttribute("aria-pressed")).toBe("true");

    const cancelableInput = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      data: "l",
    });
    act(() => {
      textarea?.dispatchEvent(cancelableInput);
    });
    expect(cancelableInput.defaultPrevented).toBe(true);
    expect(ctrlBtn?.getAttribute("aria-pressed")).toBe("false");
    expect(receivedKeys).toContainEqual({
      type: "keydown",
      key: "l",
      code: "KeyL",
      ctrlKey: true,
    });

    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="wb-term-key-pipe"]')?.click();
    });
    expect(onSendText).toHaveBeenCalledWith("|");
  });

  it("renders TerminalPanel empty state and wires createSession", () => {
    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([]);
    const activeId = createSubscribable<string | undefined>(undefined);
    const splitId = createSubscribable<string | undefined>(undefined);
    const createSession = vi.fn(async () => "term-1");

    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId,
      createSession,
      closeSession: async () => {},
      selectSession: () => {},
      renameSession: () => {},
      toggleSplit: () => {},
      attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
    };

    const host = mount(<TerminalPanel adapter={adapter} />);
    expect(host.querySelector('[data-testid="wb-terminal-empty"]')).not.toBeNull();
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="wb-term-empty-new"]')?.click();
    });
    expect(createSession).toHaveBeenCalledTimes(1);
  });
});
