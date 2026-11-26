import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createReplayGate,
  type Subscribable,
  type TerminalAdapter,
  type TerminalSessionInfo,
} from "@shaulavo/workbench-core";
import { WorkbenchPortalProvider } from "@shaulavo/workbench-ui";
import type { LinkProvider, Terminal, TerminalTheme } from "ghostty-webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyTerminalStreamEvent,
  buildGhosttyTheme,
  controlKeyFor,
  findTerminalSnapshotFileLinks,
  parseTerminalFileReference,
  pasteClipboardIntoTerminal,
  registerTerminalFileLinks,
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

  it("keeps ReplayGate recoverable on willReconnect disconnect and closes it on permanent disconnect", () => {
    const readyEvents: boolean[] = [];
    const gate = createReplayGate({
      terminal: { scrollBy: () => {}, refresh: () => {}, getRowCount: () => 24 },
      getSavedScroll: () => null,
      onReadyChange: (ready) => readyEvents.push(ready),
    });
    const fakeTerm = {
      write: vi.fn(),
      writeln: vi.fn(),
      reset: vi.fn(),
      appearance: { grid: { columns: 80, rows: 24 } },
    };
    const onResize = vi.fn();

    // Initial connect -> ready -> replay-complete -> paint -> ready=true.
    applyTerminalStreamEvent(
      { type: "ready", restoredHistory: false },
      { gate, terminal: fakeTerm, onResize },
    );
    applyTerminalStreamEvent({ type: "replay-complete" }, { gate, terminal: fakeTerm, onResize });
    gate.paint();
    expect(gate.phase()).toBe("ready");
    expect(readyEvents.at(-1)).toBe(true);

    // Recoverable disconnect disables input without permanently closing the gate.
    applyTerminalStreamEvent(
      { type: "disconnected", willReconnect: true },
      { gate, terminal: fakeTerm, onResize },
    );
    expect(gate.phase()).toBe("replaying");
    expect(readyEvents.at(-1)).toBe(false);

    // Reconnect cycle re-enables input cleanly.
    applyTerminalStreamEvent(
      { type: "ready", restoredHistory: false },
      { gate, terminal: fakeTerm, onResize },
    );
    applyTerminalStreamEvent({ type: "replay-complete" }, { gate, terminal: fakeTerm, onResize });
    gate.paint();
    expect(gate.phase()).toBe("ready");
    expect(readyEvents.at(-1)).toBe(true);

    // Permanent disconnect closes the gate so later ready events are ignored.
    applyTerminalStreamEvent(
      { type: "disconnected", willReconnect: false },
      { gate, terminal: fakeTerm, onResize },
    );
    expect(gate.phase()).toBe("closed");
    applyTerminalStreamEvent(
      { type: "ready", restoredHistory: false },
      { gate, terminal: fakeTerm, onResize },
    );
    expect(gate.phase()).toBe("closed");
  });

  it("routes context-menu Paste through terminal.paste and aborts if the session changes mid-read", async () => {
    const pasteA = vi.fn();
    const pasteB = vi.fn();
    const termA = { paste: pasteA } as unknown as Pick<Terminal, "paste">;
    const termB = { paste: pasteB } as unknown as Pick<Terminal, "paste">;

    let currentTerm = termA;
    let currentSession = "bash-1";
    const ok = await pasteClipboardIntoTerminal({
      targetTerminal: termA,
      getCurrentTerminal: () => currentTerm,
      targetSessionId: "bash-1",
      getCurrentSessionId: () => currentSession,
      isInputReady: () => true,
      readClipboard: async () => "echo hi\n",
    });
    expect(ok).toBe(true);
    expect(pasteA).toHaveBeenCalledWith("echo hi\n");

    // Simulate switching sessions while clipboard read is pending.
    const clipDeferred = Promise.withResolvers<string | null>();
    const pendingPaste = pasteClipboardIntoTerminal({
      targetTerminal: termA,
      getCurrentTerminal: () => currentTerm,
      targetSessionId: "bash-1",
      getCurrentSessionId: () => currentSession,
      isInputReady: () => true,
      readClipboard: () => clipDeferred.promise,
    });
    currentTerm = termB;
    currentSession = "logs-2";
    clipDeferred.resolve("rm -rf /");
    const cancelled = await pendingPaste;
    expect(cancelled).toBe(false);
    expect(pasteA).toHaveBeenCalledTimes(1);
    expect(pasteB).not.toHaveBeenCalled();
  });

  it("cancels pending workspace file-link opens when the link provider is disposed", async () => {
    const providerHolder: { current: LinkProvider | null } = { current: null };
    const innerDispose = vi.fn();
    const fakeTerminal = {
      registerLinkProvider(provider: LinkProvider) {
        providerHolder.current = provider;
        return { token: Symbol("test-link-provider"), dispose: innerDispose };
      },
    } as unknown as Terminal;

    const pathDeferred = Promise.withResolvers<string | null>();
    const openFileLink = vi.fn();
    const reg = registerTerminalFileLinks(fakeTerminal, {
      resolveFileLink: () => pathDeferred.promise,
      openFileLink,
    });

    const text = "src/App.tsx:10:2";
    const links = await providerHolder.current?.provideLinks(
      {
        lineIndex: 0,
        text,
        startCellByTextBoundary: Array.from({ length: text.length + 1 }, (_, i) => i),
        endCellByTextBoundary: Array.from({ length: text.length + 1 }, (_, i) => Math.max(0, i - 1)),
      } as unknown as Parameters<LinkProvider["provideLinks"]>[0],
      0,
    );
    expect(links).toHaveLength(1);
    links?.[0]?.activate(new MouseEvent("click"));

    // Dispose before resolver finishes -> openFileLink must NOT be called.
    reg.dispose();
    expect(innerDispose).toHaveBeenCalledTimes(1);
    pathDeferred.resolve("src/App.tsx");
    await Promise.resolve();
    await Promise.resolve();
    expect(openFileLink).not.toHaveBeenCalled();
  });

  it("opens TerminalPanel inline rename via keyboard F2 on a focused tab and via Rename button", () => {
    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
      { id: "bash-1", title: "bash", status: "running" },
    ]);
    const activeId = createSubscribable<string | undefined>("bash-1");
    const splitId = createSubscribable<string | undefined>(undefined);
    const renameSession = vi.fn();

    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId,
      createSession: async () => "bash-2",
      closeSession: async () => {},
      selectSession: () => {},
      renameSession,
      toggleSplit: () => {},
      attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
    };

    const host = mount(<TerminalPanel adapter={adapter} onError={() => {}} />);
    const tabButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="wb-term-tab-bash-1"] button[role="tab"]',
    );
    expect(tabButton).not.toBeNull();

    // Press F2 on the focused tab button -> inline rename input opens; Escape restores focus to the tab.
    act(() => {
      tabButton?.focus();
      tabButton?.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true }));
    });
    const renameInput = host.querySelector<HTMLInputElement>('[data-testid="wb-term-rename-input-bash-1"]');
    expect(renameInput).not.toBeNull();

    act(() => {
      renameInput?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(host.querySelector('[data-testid="wb-term-rename-input-bash-1"]')).toBeNull();
    const tabAfterCancel = host.querySelector<HTMLButtonElement>(
      '[data-testid="wb-term-tab-bash-1"] button[role="tab"]',
    );
    expect(document.activeElement).toBe(tabAfterCancel);

    // Clicking the Rename button opens inline rename; Enter commits and restores focus to the renamed tab.
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="wb-term-rename"]')?.click();
    });
    const renameInput2 = host.querySelector<HTMLInputElement>('[data-testid="wb-term-rename-input-bash-1"]');
    expect(renameInput2).not.toBeNull();
    act(() => {
      renameInput2?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(renameSession).toHaveBeenCalledWith("bash-1", "bash");
    const tabAfterCommit = host.querySelector<HTMLButtonElement>(
      '[data-testid="wb-term-tab-bash-1"] button[role="tab"]',
    );
    expect(document.activeElement).toBe(tabAfterCommit);
  });
});
