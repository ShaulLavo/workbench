import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createBrowserDispatcher, detectPlatform } from "@shaulavo/hotkeys";
import {
  createReplayGate,
  type HotkeyAdapter,
  type Subscribable,
  type TerminalAdapter,
  type TerminalSessionInfo,
  type TerminalStreamEvent,
} from "@shaulavo/workbench-core";
import { WorkbenchPortalProvider } from "@shaulavo/workbench-ui";
import { Terminal, type GhosttyRuntime, type LinkProvider, type TerminalTheme } from "ghostty-webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachConfiguredTerminalHotkeys } from "../terminal-view";
import {
  applyTerminalAppearanceToInstance,
  applyTerminalStreamEvent,
  buildGhosttyTheme,
  controlKeyFor,
  findTerminalSnapshotFileLinks,
  parseTerminalFileReference,
  pasteClipboardIntoTerminal,
  registerTerminalFileLinks,
  resolveTerminalAppearance,
  TerminalAccessoryBar,
  terminalCursorOptions,
  TerminalPanel,
  TerminalView,
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

function dispatchCopyKey(target: HTMLElement, useMeta = false): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: useMeta ? "c" : "C",
    code: "KeyC",
    ctrlKey: !useMeta,
    shiftKey: !useMeta,
    metaKey: useMeta,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

function createMockPanelTerminal(frameListeners: Set<() => void>, pasteSpy: () => void): Terminal {
  return {
    appearance: { grid: { columns: 80, rows: 24 }, theme: { palette: [] } },
    diagnostics: { rendererBackend: "mock" },
    textarea: null,
    open: async () => {},
    dispose: () => {},
    setAppearance: () => {},
    setCursor: () => {},
    setCursorInactiveStyle: () => {},
    setAccessibilityEnabled: () => {},
    refresh: () => {},
    scrollBy: () => {},
    write: () => {},
    writeln: () => {},
    reset: () => {},
    getSelection: () => "",
    selectAll: () => {},
    paste: pasteSpy,
    onFrame: (cb: () => void) => {
      frameListeners.add(cb);
      return { dispose: () => frameListeners.delete(cb) };
    },
    onData: () => ({ dispose: () => {} }),
    onResize: () => ({ dispose: () => {} }),
    on: () => ({ dispose: () => {} }),
  } as unknown as Terminal;
}

async function triggerContextPaste(root: HTMLDivElement, sessionId: string): Promise<void> {
  const viewEl = root.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
  expect(viewEl).not.toBeNull();
  act(() => {
    viewEl!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
  const pasteBtn = document.querySelector<HTMLButtonElement>('[data-testid="wb-term-ctx-paste"]');
  expect(pasteBtn).not.toBeNull();
  await act(async () => {
    pasteBtn!.click();
    await Promise.resolve();
    await Promise.resolve();
  });
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

    // Blurring the rename input to another control commits without stealing focus back to the tab.
    renameSession.mockClear();
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="wb-term-rename"]')?.click();
    });
    const renameInput3 = host.querySelector<HTMLInputElement>('[data-testid="wb-term-rename-input-bash-1"]');
    const newBtn = host.querySelector<HTMLButtonElement>('[data-testid="wb-term-new"]');
    expect(renameInput3).not.toBeNull();
    expect(newBtn).not.toBeNull();
    act(() => {
      if (renameInput3) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(renameInput3, "server");
        renameInput3.dispatchEvent(new Event("input", { bubbles: true }));
      }
      newBtn?.focus();
      renameInput3?.dispatchEvent(new FocusEvent("blur", { bubbles: true, relatedTarget: newBtn }));
    });
    expect(host.querySelector('[data-testid="wb-term-rename-input-bash-1"]')).toBeNull();
    expect(renameSession).toHaveBeenCalledWith("bash-1", "server");
    expect(document.activeElement).toBe(newBtn);
  });

  it("supports keepAlive multi-session positions, collapse toggle, splitCreatesSession, and stream metadata events", () => {
    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
      { id: "t1", title: "bash", status: "ready" },
      { id: "t2", title: "bash 2", status: "running" },
      { id: "t3", title: "bash 3", status: "starting" },
    ]);
    const activeId = createSubscribable<string | undefined>("t1");
    const splitId = createSubscribable<string | undefined>("t2");
    const onToggleCollapsed = vi.fn();
    const toggleSplit = vi.fn();

    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId,
      createSession: async () => "t4",
      closeSession: async () => {},
      selectSession: () => {},
      renameSession: () => {},
      toggleSplit,
      attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
    };

    const host = mount(
      <TerminalPanel
        adapter={adapter}
        keepAlive
        collapsed
        splitCreatesSession
        onToggleCollapsed={onToggleCollapsed}
        headerTrailing={<span data-testid="term-state-badge">ready</span>}
        onError={() => {}}
      />,
    );

    const panel = host.querySelector<HTMLElement>("[data-wb-terminal-panel]");
    expect(panel?.getAttribute("data-collapsed")).toBe("true");
    expect(host.querySelector('[data-testid="term-state-badge"]')?.textContent).toBe("ready");

    // All three sessions remain mounted with single/left/right/hidden positions.
    expect(host.querySelector('[data-session-id="t1"]')?.getAttribute("data-position")).toBe("left");
    expect(host.querySelector('[data-session-id="t2"]')?.getAttribute("data-position")).toBe("right");
    expect(host.querySelector('[data-session-id="t3"]')?.getAttribute("data-position")).toBe("hidden");

    // Switching primary to t2 and secondary to t1 (where t1 precedes t2 in sessions) keeps left before right.
    act(() => {
      activeId.set("t2");
      splitId.set("t1");
    });
    const orderedIds = Array.from(host.querySelectorAll<HTMLElement>("[data-wb-terminal]"), (el) => ({
      id: el.dataset.sessionId,
      pos: el.dataset.position,
    }));
    expect(orderedIds).toEqual([
      { id: "t2", pos: "left" },
      { id: "t1", pos: "right" },
      { id: "t3", pos: "hidden" },
    ]);

    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="wb-term-collapse"]')?.click();
    });
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);

    // Stream metadata events dispatch onProcessChange, onTitleChange, and onExit.
    const onProcessChange = vi.fn();
    const onTitleChange = vi.fn();
    const onExit = vi.fn();
    const gate = createReplayGate({
      terminal: { scrollBy: () => {}, refresh: () => {}, getRowCount: () => 24 },
      getSavedScroll: () => null,
      onReadyChange: () => {},
    });
    const fakeTerm = {
      write: vi.fn(),
      writeln: vi.fn(),
      reset: vi.fn(),
      appearance: { grid: { columns: 80, rows: 24 } },
    };
    const target = {
      gate,
      terminal: fakeTerm,
      onResize: vi.fn(),
      onProcessChange,
      onTitleChange,
      onExit,
    };
    applyTerminalStreamEvent({ type: "process", name: "vite" }, target);
    applyTerminalStreamEvent({ type: "title", title: "dev server" }, target);
    applyTerminalStreamEvent({ type: "exit", exitCode: 0 }, target);
    expect(onProcessChange).toHaveBeenCalledWith("vite");
    expect(onTitleChange).toHaveBeenCalledWith("dev server");
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it("propagates themeOverride lineHeight and delegates runtime creation to custom loadRuntime", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const resolved = resolveTerminalAppearance(host, {
        override: {
          colorScheme: "dark",
          background: { r: 0, g: 0, b: 0 },
          foreground: { r: 255, g: 255, b: 255 },
          cursor: { r: 255, g: 255, b: 255 },
          cursorAccent: { r: 10, g: 10, b: 10 },
          selectionBackground: { r: 60, g: 60, b: 60 },
          selectionForeground: { r: 255, g: 255, b: 255 },
          ansi: Array.from({ length: 16 }, () => ({ r: 128, g: 128, b: 128 })),
          backgroundOpacity: 0,
          lineHeight: 1,
        },
      });
      expect(resolved.lineHeight).toBe(1);
      expect(resolved.backgroundOpacity).toBe(0);
      const setAppearance = vi.fn();
      const fakeTerm = {
        appearance: { theme: { palette: Array.from({ length: 16 }, () => ({ r: 0, g: 0, b: 0 })) } },
        setAppearance,
      };
      applyTerminalAppearanceToInstance(fakeTerm as never, resolved, true);
      expect(setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({
          backgroundOpacity: 0,
          font: expect.objectContaining({ lineHeight: 1 }),
        }),
      );
    } finally {
      host.remove();
    }

    const loadRuntime = vi.fn((_signal: AbortSignal) => Promise.reject(new Error("custom runtime loader")));
    const onError = vi.fn();
    const adapter: TerminalAdapter = {
      sessions: createSubscribable<readonly TerminalSessionInfo[]>([
        { id: "s1", title: "bash", status: "ready" },
      ]),
      activeId: createSubscribable<string | undefined>("s1"),
      splitId: createSubscribable<string | undefined>(undefined),
      createSession: async () => "s2",
      closeSession: async () => {},
      selectSession: () => {},
      renameSession: () => {},
      toggleSplit: () => {},
      attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
    };

    mount(<TerminalView adapter={adapter} sessionId="s1" loadRuntime={loadRuntime} onError={onError} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadRuntime).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("custom runtime loader", expect.any(Error));
  });

  it("aborts custom loadRuntime on unmount and suppresses late rejection errors", async () => {
    let capturedSignal: AbortSignal | undefined;
    let rejectDeferred: ((reason?: unknown) => void) | undefined;
    const deferredLoadRuntime = vi.fn((signal: AbortSignal) => {
      capturedSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        rejectDeferred = reject;
      });
    });
    const onAbortedError = vi.fn();
    const adapter: TerminalAdapter = {
      sessions: createSubscribable<readonly TerminalSessionInfo[]>([
        { id: "s1", title: "bash", status: "ready" },
      ]),
      activeId: createSubscribable<string | undefined>("s1"),
      splitId: createSubscribable<string | undefined>(undefined),
      createSession: async () => "s2",
      closeSession: async () => {},
      selectSession: () => {},
      renameSession: () => {},
      toggleSplit: () => {},
      attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
    };

    mount(
      <TerminalView
        adapter={adapter}
        sessionId="s1"
        loadRuntime={deferredLoadRuntime}
        onError={onAbortedError}
      />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(capturedSignal?.aborted).toBe(false);
    act(() => {
      activeRoot?.unmount();
      activeRoot = null;
    });
    expect(capturedSignal?.aborted).toBe(true);
    rejectDeferred?.(new Error("aborted after unmount"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onAbortedError).not.toHaveBeenCalled();
  });

  it("forwards onHotkeyError, console fallback, and live screenReaderMode in hosted and standalone modes", async () => {
    const originalClipboard = navigator.clipboard;
    const originalPlatform = navigator.platform;
    const copyError = new Error("clipboard write denied");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.reject(copyError)) },
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const host = document.createElement("div");
    host.tabIndex = 0;
    document.body.appendChild(host);
    host.focus();

    let claimKey: ((input: { readonly type: "key"; readonly event: KeyboardEvent }) => string) | undefined;
    const sendGeneratedInput = vi.fn();
    const fakeTerminal = {
      element: host,
      lifecycle: "open",
      pendingWriteBytes: 0,
      appearance: { font: { size: 13 } },
      inputModes: {},
      getSelection: () => "selected text",
      connectInput: (handler: (input: { readonly type: "key"; readonly event: KeyboardEvent }) => string) => {
        claimKey = handler;
        const abort = new AbortController();
        return { signal: abort.signal, dispose: () => abort.abort() };
      },
      on: () => ({ dispose: () => {} }),
      sendGeneratedInput,
    } as unknown as Terminal;

    const dispatcher = createBrowserDispatcher({
      root: host,
      platform: "linux",
      keymap: [{ keys: "Ctrl+Shift+C", command: "terminal.copy", context: "Terminal && screenReader == on" }],
    });
    const parent = dispatcher.createNode({ parent: null });
    let screenReader = false;
    let onHotkeyError: ((cause: unknown, operation: string) => void) | undefined = vi.fn();
    const baseHotkeys: HotkeyAdapter = {
      registerCommands: () => () => {},
      getBindings: () => [],
      formatHint: () => undefined,
      isTextEntryTarget: () => false,
    };
    const hostedHotkeys: HotkeyAdapter = {
      ...baseHotkeys,
      getTerminalParentScope: () => ({ dispatcher, parent }),
    };

    let hostedDispose: (() => void) | null = null;
    let standaloneDispose: (() => void) | null = null;
    try {
      hostedDispose = attachConfiguredTerminalHotkeys(fakeTerminal, {
        hotkeys: hostedHotkeys,
        getScreenReader: () => screenReader,
        getOnError: () => onHotkeyError,
      });
      host.focus();

      // Screen reader is false: when-clause suppresses copy command.
      claimKey?.({ type: "key", event: dispatchCopyKey(host) });
      await flushMicrotasks();
      expect(onHotkeyError).not.toHaveBeenCalled();

      // Flip live screenReader to true: hosted copy triggers custom onHotkeyError.
      screenReader = true;
      claimKey?.({ type: "key", event: dispatchCopyKey(host) });
      await flushMicrotasks();
      expect(onHotkeyError).toHaveBeenCalledWith(copyError, "terminal.copy");

      // Omit onHotkeyError: falls back to console.error.
      onHotkeyError = undefined;
      claimKey?.({ type: "key", event: dispatchCopyKey(host) });
      await flushMicrotasks();
      expect(consoleError).toHaveBeenCalledWith("terminal.copy", copyError);

      hostedDispose?.();
      hostedDispose = null;
      consoleError.mockClear();

      // Standalone mode (macOS keymap): verify custom onHotkeyError, console fallback, and live screenReaderMode.
      Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
      const standaloneError = vi.fn();
      onHotkeyError = standaloneError;
      let standaloneScreenReader = false;
      standaloneDispose = attachConfiguredTerminalHotkeys(fakeTerminal, {
        hotkeys: baseHotkeys,
        getScreenReader: () => standaloneScreenReader,
        getOnError: () => onHotkeyError,
      });
      host.focus();
      const isMac = detectPlatform() === "mac";
      expect(isMac).toBe(true);

      // Meta+ArrowLeft binds to sendKeystroke('\x01') only while screenReader == off.
      const metaLeft = () =>
        new KeyboardEvent("keydown", {
          key: "ArrowLeft",
          code: "ArrowLeft",
          metaKey: true,
          bubbles: true,
          cancelable: true,
        });
      const offEvent = metaLeft();
      host.dispatchEvent(offEvent);
      claimKey?.({ type: "key", event: offEvent });
      await flushMicrotasks();
      expect(sendGeneratedInput).toHaveBeenCalledWith({ type: "text", data: "\x01" });

      sendGeneratedInput.mockClear();
      standaloneScreenReader = true;
      const onEvent = metaLeft();
      host.dispatchEvent(onEvent);
      claimKey?.({ type: "key", event: onEvent });
      await flushMicrotasks();
      expect(sendGeneratedInput).not.toHaveBeenCalled();

      claimKey?.({ type: "key", event: dispatchCopyKey(host, true) });
      await flushMicrotasks();
      expect(standaloneError).toHaveBeenCalledWith(copyError, "terminal.copy");

      onHotkeyError = undefined;
      claimKey?.({ type: "key", event: dispatchCopyKey(host, true) });
      await flushMicrotasks();
      expect(consoleError).toHaveBeenCalledWith("terminal.copy", copyError);
    } finally {
      hostedDispose?.();
      standaloneDispose?.();
      parent.remove();
      dispatcher.dispose();
      host.remove();
      consoleError.mockRestore();
      Object.defineProperty(navigator, "platform", { configurable: true, value: originalPlatform });
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
    }
  });

  it("delivers onPasteFailed with sessionId and suppresses late rejections after keepAlive tab switch", async () => {
    const originalClipboard = navigator.clipboard;
    const frameListeners = new Set<() => void>();
    const pasteSpy = vi.fn();
    const createSpy = vi
      .spyOn(Terminal, "create")
      .mockImplementation(async () => createMockPanelTerminal(frameListeners, pasteSpy));

    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
      { id: "one", title: "bash 1", status: "ready" },
      { id: "two", title: "bash 2", status: "ready" },
    ]);
    const activeId = createSubscribable<string | undefined>("one");
    const splitId = createSubscribable<string | undefined>(undefined);
    const streamHandlers = new Map<string, (event: TerminalStreamEvent) => void>();
    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId,
      createSession: async () => "three",
      closeSession: async () => {},
      selectSession: (id) => activeId.set(id),
      renameSession: () => {},
      toggleSplit: () => {},
      attach: async (id, callbacks) => {
        streamHandlers.set(id, callbacks.onEvent);
        return { write: () => {}, resize: () => {}, detach: () => {} };
      },
    };
    const onPasteFailed = vi.fn();
    const fakeRuntime = {} as GhosttyRuntime;

    try {
      const root = mount(
        <TerminalPanel
          adapter={adapter}
          keepAlive
          loadRuntime={async () => fakeRuntime}
          onPasteFailed={onPasteFailed}
        />,
      );
      await act(async () => {
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
      act(() => {
        streamHandlers.get("one")?.({ type: "ready" });
        streamHandlers.get("one")?.({ type: "replay-complete" });
        for (const listener of frameListeners) listener();
      });

      // Unavailable clipboard reports ("one", "unavailable").
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
      await triggerContextPaste(root, "one");
      expect(onPasteFailed).toHaveBeenLastCalledWith("one", "unavailable");

      // Denied clipboard reports ("one", "denied").
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: vi.fn(() => Promise.reject(new Error("denied"))) },
      });
      await triggerContextPaste(root, "one");
      expect(onPasteFailed).toHaveBeenLastCalledWith("one", "denied");

      // Pending clipboard read rejected after keepAlive tab switch is suppressed.
      onPasteFailed.mockClear();
      let rejectPending: ((reason?: unknown) => void) | undefined;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          readText: vi.fn(
            () =>
              new Promise<string>((_resolve, reject) => {
                rejectPending = reject;
              }),
          ),
        },
      });
      await triggerContextPaste(root, "one");
      act(() => {
        activeId.set("two");
      });
      rejectPending?.(new Error("late denial"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onPasteFailed).not.toHaveBeenCalled();
      expect(pasteSpy).not.toHaveBeenCalled();

      // Switching away and back to "one" before a pre-switch read settles suppresses both stale error and stale paste.
      act(() => {
        activeId.set("one");
      });
      let rejectRoundTrip: ((reason?: unknown) => void) | undefined;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          readText: vi.fn(
            () =>
              new Promise<string>((_resolve, reject) => {
                rejectRoundTrip = reject;
              }),
          ),
        },
      });
      await triggerContextPaste(root, "one");
      act(() => {
        activeId.set("two");
      });
      act(() => {
        activeId.set("one");
      });
      rejectRoundTrip?.(new Error("stale after round-trip"));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(onPasteFailed).not.toHaveBeenCalled();

      // Resolving a pre-switch clipboard read after switching away and back must not paste into "one".
      let resolveRoundTrip: ((text: string) => void) | undefined;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          readText: vi.fn(
            () =>
              new Promise<string>((resolve) => {
                resolveRoundTrip = resolve;
              }),
          ),
        },
      });
      await triggerContextPaste(root, "one");
      act(() => {
        activeId.set("two");
      });
      act(() => {
        activeId.set("one");
      });
      resolveRoundTrip?.("stale clipboard text");
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(pasteSpy).not.toHaveBeenCalled();

      // Switching away from "one" closes its context menu and blocks any queued Paste microtask.
      const readWhenHidden = vi.fn(async () => "hidden paste");
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: readWhenHidden },
      });
      const viewOne = root.querySelector<HTMLElement>('[data-session-id="one"]');
      act(() => {
        viewOne!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      });
      const hiddenPasteBtn = document.querySelector<HTMLButtonElement>('[data-testid="wb-term-ctx-paste"]');
      expect(hiddenPasteBtn).not.toBeNull();
      act(() => {
        hiddenPasteBtn!.click();
        activeId.set("two");
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(document.querySelector('[data-testid="wb-term-ctx-paste"]')).toBeNull();
      expect(readWhenHidden).not.toHaveBeenCalled();
      expect(pasteSpy).not.toHaveBeenCalled();

      // Switching away with the menu still open (without clicking an item) or receiving a delayed
      // contextmenu while hidden keeps the menu closed after returning to "one".
      act(() => {
        activeId.set("one");
      });
      act(() => {
        viewOne!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      });
      expect(document.querySelector('[data-testid="wb-term-ctx-paste"]')).not.toBeNull();
      act(() => {
        activeId.set("two");
      });
      expect(document.querySelector('[data-testid="wb-term-ctx-paste"]')).toBeNull();
      act(() => {
        viewOne!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      });
      act(() => {
        activeId.set("one");
      });
      expect(document.querySelector('[data-testid="wb-term-ctx-paste"]')).toBeNull();

      // Pasting normally while active delivers clipboard text.
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { readText: vi.fn(async () => "active paste") },
      });
      await triggerContextPaste(root, "one");
      expect(pasteSpy).toHaveBeenCalledWith("active paste");
    } finally {
      createSpy.mockRestore();
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
    }
  });

  it("invokes onBeforeDispose before terminal.dispose on unmount and always disposes even if it throws", async () => {
    const events: string[] = [];
    let disposed = false;
    const fakeRuntime = {} as GhosttyRuntime;
    const makeFakeTerminal = () => {
      const base = createMockPanelTerminal(new Set(), () => {});
      return Object.assign(base, {
        dispose: vi.fn(() => {
          disposed = true;
          events.push("dispose");
        }),
        captureViewport: vi.fn(() => {
          if (disposed) throw new Error("Terminal has been disposed");
          events.push("capture");
          return "snapshot";
        }),
      });
    };

    const createSpy = vi
      .spyOn(Terminal, "create")
      .mockImplementation(async () => makeFakeTerminal() as unknown as Terminal);
    const adapter: TerminalAdapter = {
      sessions: createSubscribable<readonly TerminalSessionInfo[]>([]),
      activeId: createSubscribable<string | undefined>(undefined),
      splitId: createSubscribable<string | undefined>(undefined),
      createSession: async () => "s1",
      closeSession: async () => {},
      selectSession: () => {},
      renameSession: () => {},
      toggleSplit: () => {},
      attach: async () => ({
        write: () => {},
        resize: () => {},
        detach: () => {
          events.push("detach");
        },
      }),
    };

    try {
      const observedTerminals: Terminal[] = [];
      let readyTerminal: Terminal | null = null;
      const container = document.createElement("div");
      document.body.appendChild(container);
      const reactRoot = createRoot(container);
      act(() => {
        reactRoot.render(
          <TerminalView
            adapter={adapter}
            sessionId="s1"
            loadRuntime={async () => fakeRuntime}
            onTerminalReady={(t) => {
              readyTerminal = t;
            }}
            onBeforeDispose={(t) => {
              observedTerminals.push(t);
              events.push("before-dispose");
              (t as unknown as { captureViewport(): string }).captureViewport();
            }}
          />,
        );
      });
      await act(async () => {
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
      expect(readyTerminal).not.toBeNull();

      act(() => {
        reactRoot.unmount();
      });
      container.remove();

      expect(observedTerminals).toEqual([readyTerminal]);
      expect(events).toEqual(["detach", "before-dispose", "capture", "dispose"]);

      // Even if onBeforeDispose throws, terminal.dispose() still runs in finally.
      events.length = 0;
      disposed = false;
      const container2 = document.createElement("div");
      document.body.appendChild(container2);
      const reactRoot2 = createRoot(container2);
      act(() => {
        reactRoot2.render(
          <TerminalView
            adapter={adapter}
            sessionId="s2"
            loadRuntime={async () => fakeRuntime}
            onBeforeDispose={() => {
              events.push("before-dispose-throw");
              throw new Error("consumer capture error");
            }}
          />,
        );
      });
      await act(async () => {
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      });
      expect(() => {
        act(() => {
          reactRoot2.unmount();
        });
      }).toThrow("consumer capture error");
      container2.remove();
      expect(disposed).toBe(true);
      expect(events).toEqual(["detach", "before-dispose-throw", "dispose"]);
    } finally {
      createSpy.mockRestore();
    }
  });
});
