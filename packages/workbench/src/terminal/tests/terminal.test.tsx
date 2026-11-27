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
} from "../../core/index";
import { WorkbenchPortalProvider } from "../../ui/index";
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
    focus: () => {},
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
        theme: {
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

  it("parses parenthesized file(line,col) diagnostics and bare Makefile/Dockerfile names", () => {
    expect(parseTerminalFileReference("src/App.tsx(12,4)")).toEqual({
      path: "src/App.tsx",
      line: 12,
      column: 4,
    });
    expect(parseTerminalFileReference("src/App.tsx(12)")).toEqual({
      path: "src/App.tsx",
      line: 12,
    });
    expect(parseTerminalFileReference("Makefile")).toEqual({ path: "Makefile" });
    expect(parseTerminalFileReference("Makefile:10")).toEqual({ path: "Makefile", line: 10 });
    expect(parseTerminalFileReference("Dockerfile")).toEqual({ path: "Dockerfile" });

    const text =
      "error:src/App.tsx(12,4): see Makefile, src/app/(dashboard)/page.tsx:12:4, error:(src/err.ts:9:1), include(src/inc.ts) and (src/other.ts:7:2)";
    const boundaries = Array.from({ length: text.length + 1 }, (_, i) => i);
    const links = findTerminalSnapshotFileLinks({
      text,
      startCellByTextBoundary: boundaries,
      endCellByTextBoundary: boundaries,
    });
    expect(links.map((l) => l.reference)).toEqual([
      { path: "src/App.tsx", line: 12, column: 4 },
      { path: "Makefile" },
      { path: "src/app/(dashboard)/page.tsx", line: 12, column: 4 },
      { path: "src/err.ts", line: 9, column: 1 },
      { path: "src/inc.ts" },
      { path: "src/other.ts", line: 7, column: 2 },
    ]);

    // Malformed parenthesized suffixes must not emit partial paths or bogus line links,
    // while valid references immediately following a malformed suffix still parse.
    const malformed = "src/App.tsx(12,) src/App.tsx(12,x) src/App.tsx(12,4)junk src/App.tsx(12,x)junk.ts:9:1";
    const malformedBounds = Array.from({ length: malformed.length + 1 }, (_, i) => i);
    expect(
      findTerminalSnapshotFileLinks({
        text: malformed,
        startCellByTextBoundary: malformedBounds,
        endCellByTextBoundary: malformedBounds,
      }),
    ).toEqual([]);

    const adjacent = "src/App.tsx(12,x):(src/err.ts:9:1)";
    const adjacentBounds = Array.from({ length: adjacent.length + 1 }, (_, i) => i);
    expect(
      findTerminalSnapshotFileLinks({
        text: adjacent,
        startCellByTextBoundary: adjacentBounds,
        endCellByTextBoundary: adjacentBounds,
      }).map((l) => l.reference),
    ).toEqual([{ path: "src/err.ts", line: 9, column: 1 }]);
  });

  it("moves focus to the terminal on New terminal, tab click, and Split while keeping arrow-key navigation on tabs", async () => {
    const focusSpies = new Map<string, ReturnType<typeof vi.fn>>();
    let nextId = 2;
    const createSpy = vi.spyOn(Terminal, "create").mockImplementation(async () => {
      const focusSpy = vi.fn();
      return Object.assign(
        createMockPanelTerminal(new Set(), () => {}),
        { focus: focusSpy },
      );
    });

    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
      { id: "t1", title: "bash 1", status: "ready" },
      { id: "t2", title: "bash 2", status: "ready" },
    ]);
    const activeId = createSubscribable<string | undefined>("t2");
    const splitId = createSubscribable<string | undefined>(undefined);
    const closed: string[] = [];
    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId,
      async createSession() {
        nextId += 1;
        const id = `t${nextId}`;
        sessions.set(sessions.getSnapshot().concat([{ id, title: `bash ${nextId}`, status: "ready" }]));
        activeId.set(id);
        return id;
      },
      async closeSession(id) {
        closed.push(id);
      },
      selectSession(id) {
        activeId.set(id);
      },
      renameSession() {},
      toggleSplit() {
        splitId.set(splitId.getSnapshot() ? undefined : "t1");
      },
      attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
    };

    try {
      const root = mount(
        <TerminalPanel
          adapter={adapter}
          keepAlive
          loadRuntime={async () => ({}) as GhosttyRuntime}
          onTerminalReady={(id, term) => {
            focusSpies.set(id, term.focus as unknown as ReturnType<typeof vi.fn>);
          }}
        />,
      );
      await act(async () => {
        await flushMicrotasks();
      });

      // ArrowRight from tab 2 wraps to tab 1, selects t1, and keeps keyboard focus on tab 1's button.
      const tab2Btn = root.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-t2"] button[role="tab"]',
      )!;
      const tab1Btn = root.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-t1"] button[role="tab"]',
      )!;
      act(() => {
        tab2Btn.focus();
        tab2Btn.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
        );
      });
      expect(activeId.getSnapshot()).toBe("t1");
      expect(document.activeElement).toBe(tab1Btn);
      expect(focusSpies.get("t1")).not.toHaveBeenCalled();

      // Clicking tab 2 selects t2 and moves focus to t2's terminal.
      act(() => {
        tab2Btn.click();
      });
      expect(activeId.getSnapshot()).toBe("t2");
      expect(focusSpies.get("t2")).toHaveBeenCalledTimes(1);

      // Clicking New terminal creates t3 and focuses t3 once attached.
      const newBtn = root.querySelector<HTMLButtonElement>('[data-testid="wb-term-new"]')!;
      act(() => {
        newBtn.focus();
        newBtn.click();
      });
      await act(async () => {
        await flushMicrotasks();
      });
      expect(activeId.getSnapshot()).toBe("t3");
      expect(focusSpies.get("t3")).toHaveBeenCalledTimes(1);

      // Clicking Split focuses the split terminal (t1).
      const splitBtn = root.querySelector<HTMLButtonElement>('[data-testid="wb-term-split"]')!;
      act(() => {
        splitBtn.click();
      });
      expect(splitId.getSnapshot()).toBe("t1");
      expect(focusSpies.get("t1")).toHaveBeenCalledTimes(1);

      // Delete on a focused tab closes that session (re-query inside split group after splitting).
      const liveTab1Btn = root.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-t1"] button[role="tab"]',
      )!;
      act(() => {
        liveTab1Btn.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
        );
      });
      expect(closed).toEqual(["t1"]);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("restores focus on async Delete, expands collapsed empty New, and ignores stale createSession focus", async () => {
    const focusSpies = new Map<string, ReturnType<typeof vi.fn>>();
    let createCalls = 0;
    let resolveCreateB: (() => void) | undefined;
    const createSpy = vi.spyOn(Terminal, "create").mockImplementation(async () => {
      createCalls += 1;
      // Delay the second terminal creation (session "b" when switching from "a") until after New resolves.
      if (createCalls === 2) {
        await new Promise<void>((resolve) => {
          resolveCreateB = resolve;
        });
      }
      const focusSpy = vi.fn();
      return Object.assign(
        createMockPanelTerminal(new Set(), () => {}),
        { focus: focusSpy },
      );
    });

    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
      { id: "a", title: "bash 1", status: "ready" },
      { id: "b", title: "bash 2", status: "ready" },
    ]);
    const activeId = createSubscribable<string | undefined>("a");
    const splitId = createSubscribable<string | undefined>(undefined);
    let resolveCreate: ((id: string) => void) | undefined;
    let resolveCloseLast: (() => void) | undefined;
    const onToggleCollapsed = vi.fn();

    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId,
      createSession() {
        return new Promise<string>((resolve) => {
          resolveCreate = resolve;
        });
      },
      async closeSession(id) {
        if (sessions.getSnapshot().length === 1) {
          // Simulate an async close with an interim status update before the closing tab disappears.
          sessions.set([{ id, title: "bash 2", status: "exited" }]);
          await new Promise<void>((resolve) => {
            resolveCloseLast = resolve;
          });
        }
        const next = sessions.getSnapshot().filter((s) => s.id !== id);
        sessions.set(next);
        if (activeId.getSnapshot() === id) activeId.set(next[0]?.id);
      },
      selectSession(id) {
        activeId.set(id);
      },
      renameSession() {},
      toggleSplit() {},
      attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
    };

    try {
      const root = mount(
        <TerminalPanel
          adapter={adapter}
          keepAlive={false}
          loadRuntime={async () => ({}) as GhosttyRuntime}
          onTerminalReady={(id, term) => {
            focusSpies.set(id, term.focus as unknown as ReturnType<typeof vi.fn>);
          }}
        />,
      );
      await act(async () => {
        await flushMicrotasks();
      });

      // Click New, then click B while B is still opening -> late New resolution must not overwrite B's pending focus.
      const newBtn = root.querySelector<HTMLButtonElement>('[data-testid="wb-term-new"]')!;
      const tabBBtn = root.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-b"] button[role="tab"]',
      )!;
      act(() => {
        newBtn.click();
        tabBBtn.click();
      });
      await act(async () => {
        resolveCreate?.("c");
        await flushMicrotasks();
      });
      expect(focusSpies.get("b")).toBeUndefined();
      await act(async () => {
        resolveCreateB?.();
        await flushMicrotasks();
      });
      expect(focusSpies.get("b")).toHaveBeenCalledTimes(1);

      // Delete on focused tab A moves focus to surviving tab B.
      const tabABtn = root.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-a"] button[role="tab"]',
      )!;
      act(() => {
        tabABtn.focus();
        tabABtn.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
        );
      });
      const survivingB = root.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-b"] button[role="tab"]',
      )!;
      expect(document.activeElement).toBe(survivingB);

      // Async Delete on last tab B with an interim status update keeps restore pending until B disappears.
      act(() => {
        survivingB.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        await flushMicrotasks();
      });
      await act(async () => {
        resolveCloseLast?.();
        await flushMicrotasks();
      });
      expect(document.activeElement).toBe(newBtn);

      // Empty New while collapsed calls onToggleCollapsed.
      act(() => {
        activeRoot?.render(
          <WorkbenchPortalProvider>
            <TerminalPanel
              adapter={adapter}
              collapsed
              onToggleCollapsed={onToggleCollapsed}
              loadRuntime={async () => ({}) as GhosttyRuntime}
            />
          </WorkbenchPortalProvider>,
        );
      });
      act(() => {
        root.querySelector<HTMLButtonElement>('[data-testid="wb-term-empty-new"]')?.click();
      });
      expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("does not steal focus when user moves focus elsewhere during async Delete", async () => {
    const createSpy = vi
      .spyOn(Terminal, "create")
      .mockImplementation(async () => createMockPanelTerminal(new Set(), () => {}));
    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
      { id: "only", title: "bash 1", status: "ready" },
    ]);
    const activeId = createSubscribable<string | undefined>("only");
    const splitId = createSubscribable<string | undefined>(undefined);
    let resolveClose: (() => void) | undefined;

    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId,
      createSession: async () => "next",
      async closeSession(id) {
        sessions.set([{ id, title: "bash 1", status: "exited" }]);
        await new Promise<void>((resolve) => {
          resolveClose = resolve;
        });
        sessions.set([]);
        activeId.set(undefined);
      },
      selectSession: (id) => activeId.set(id),
      renameSession: () => {},
      toggleSplit: () => {},
      attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
    };

    const externalInput = document.createElement("input");
    document.body.appendChild(externalInput);
    try {
      const root = mount(
        <TerminalPanel adapter={adapter} loadRuntime={async () => ({}) as GhosttyRuntime} />,
      );
      await act(async () => {
        await flushMicrotasks();
      });
      const tabBtn = root.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-only"] button[role="tab"]',
      )!;
      act(() => {
        tabBtn.focus();
        tabBtn.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }),
        );
      });
      await act(async () => {
        await flushMicrotasks();
      });
      // User moves focus to an unrelated input before the async close completes.
      act(() => {
        externalInput.focus();
      });
      await act(async () => {
        resolveClose?.();
        await flushMicrotasks();
      });
      expect(document.activeElement).toBe(externalInput);
    } finally {
      externalInput.remove();
      createSpy.mockRestore();
    }
  });

  it("removes disposed terminals from the focus map when keepAlive is false so switching and splitting never focus a disposed terminal", async () => {
    const liveFocusBySession = new Map<string, ReturnType<typeof vi.fn>>();
    const createSpy = vi.spyOn(Terminal, "create").mockImplementation(async () => {
      let disposed = false;
      const focusSpy = vi.fn(() => {
        if (disposed) throw new Error("Terminal is not open; lifecycle is disposed");
      });
      return Object.assign(
        createMockPanelTerminal(new Set(), () => {}),
        {
          focus: focusSpy,
          dispose: vi.fn(() => {
            disposed = true;
          }),
        },
      );
    });

    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
      { id: "a", title: "bash 1", status: "ready" },
      { id: "b", title: "bash 2", status: "ready" },
    ]);
    const activeId = createSubscribable<string | undefined>("a");
    const splitId = createSubscribable<string | undefined>(undefined);
    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId,
      createSession: async () => "c",
      closeSession: async () => {},
      selectSession(id) {
        activeId.set(id);
      },
      renameSession() {},
      toggleSplit() {
        splitId.set(splitId.getSnapshot() ? undefined : "a");
      },
      attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
    };

    try {
      const root = mount(
        <TerminalPanel
          adapter={adapter}
          keepAlive={false}
          loadRuntime={async () => ({}) as GhosttyRuntime}
          onTerminalReady={(id, term) => {
            liveFocusBySession.set(id, term.focus as unknown as ReturnType<typeof vi.fn>);
          }}
        />,
      );
      await act(async () => {
        await flushMicrotasks();
      });

      // Switch A -> B (unmounts and disposes A).
      const tabBBtn = root.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-b"] button[role="tab"]',
      )!;
      act(() => {
        tabBBtn.click();
      });
      await act(async () => {
        await flushMicrotasks();
      });
      expect(liveFocusBySession.get("b")).toHaveBeenCalledTimes(1);

      // Click Split to show A beside B: must not call focus() on disposed A, and must focus the fresh A once attached.
      const firstAFocus = liveFocusBySession.get("a")!;
      const splitBtn = root.querySelector<HTMLButtonElement>('[data-testid="wb-term-split"]')!;
      act(() => {
        splitBtn.click();
      });
      await act(async () => {
        await flushMicrotasks();
      });
      const freshAFocus = liveFocusBySession.get("a")!;
      expect(freshAFocus).not.toBe(firstAFocus);
      expect(freshAFocus).toHaveBeenCalledTimes(1);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("invokes onBeforeDispose while host is connected and preserves outgoing session callback on session switch", async () => {
    const events: string[] = [];
    let disposed = false;
    let hostElement: HTMLElement | null = null;
    let hostConnectedAtCapture = false;
    const fakeRuntime = {} as GhosttyRuntime;

    const makeFakeTerminal = () => {
      const base = createMockPanelTerminal(new Set(), () => {});
      return Object.assign(base, {
        open: vi.fn(async (host: HTMLElement) => {
          hostElement = host;
        }),
        dispose: vi.fn(() => {
          disposed = true;
          events.push("dispose");
        }),
        captureViewport: vi.fn(() => {
          if (disposed) throw new Error("Terminal has been disposed");
          hostConnectedAtCapture = Boolean(hostElement?.isConnected);
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

    const container = document.createElement("div");
    document.body.appendChild(container);
    const reactRoot = createRoot(container);
    try {
      const seenOne: Array<{ readonly terminal: Terminal; readonly sessionId: string }> = [];
      const seenTwo: Array<{ readonly terminal: Terminal; readonly sessionId: string }> = [];
      let terminalOne: Terminal | null = null;
      let terminalTwo: Terminal | null = null;

      act(() => {
        reactRoot.render(
          <TerminalView
            adapter={adapter}
            sessionId="one"
            loadRuntime={async () => fakeRuntime}
            onTerminalReady={(t) => {
              terminalOne = t;
            }}
            onBeforeDispose={(t, sid) => {
              seenOne.push({ terminal: t, sessionId: sid });
              events.push("before-dispose");
              (t as unknown as { captureViewport(): string }).captureViewport();
            }}
          />,
        );
      });
      await act(async () => {
        await flushMicrotasks();
      });
      expect(terminalOne).not.toBeNull();

      // Switching sessionId on one mounted view must deliver terminalOne to one's callback, not two's.
      act(() => {
        reactRoot.render(
          <TerminalView
            adapter={adapter}
            sessionId="two"
            loadRuntime={async () => fakeRuntime}
            onTerminalReady={(t) => {
              terminalTwo = t;
            }}
            onBeforeDispose={(t, sid) => {
              seenTwo.push({ terminal: t, sessionId: sid });
              events.push("before-dispose-two");
              (t as unknown as { captureViewport(): string }).captureViewport();
            }}
          />,
        );
      });
      await act(async () => {
        await flushMicrotasks();
      });
      expect(seenOne).toEqual([{ terminal: terminalOne, sessionId: "one" }]);
      expect(seenTwo).toEqual([]);
      expect(hostConnectedAtCapture).toBe(true);
      expect(events).toEqual(["detach", "before-dispose", "capture", "dispose"]);
      expect(terminalTwo).not.toBeNull();

      // Unmounting runs onBeforeDispose while host is still connected to the document.
      events.length = 0;
      disposed = false;
      hostConnectedAtCapture = false;
      act(() => {
        reactRoot.unmount();
      });
      expect(seenTwo).toEqual([{ terminal: terminalTwo, sessionId: "two" }]);
      expect(hostConnectedAtCapture).toBe(true);
      expect(events).toEqual(["detach", "before-dispose-two", "capture", "dispose"]);
    } finally {
      createSpy.mockRestore();
      container.remove();
    }
  });

  it("skips onBeforeDispose when onTerminalReady was not supplied", async () => {
    const onBeforeDispose = vi.fn();
    const disposeSpy = vi.fn();
    const createSpy = vi.spyOn(Terminal, "create").mockImplementation(async () =>
      Object.assign(
        createMockPanelTerminal(new Set(), () => {}),
        { dispose: disposeSpy },
      ),
    );
    const adapter: TerminalAdapter = {
      sessions: createSubscribable<readonly TerminalSessionInfo[]>([]),
      activeId: createSubscribable<string | undefined>(undefined),
      splitId: createSubscribable<string | undefined>(undefined),
      createSession: async () => "s1",
      closeSession: async () => {},
      selectSession: () => {},
      renameSession: () => {},
      toggleSplit: () => {},
      attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const reactRoot = createRoot(container);
    try {
      act(() => {
        reactRoot.render(
          <TerminalView
            adapter={adapter}
            sessionId="s1"
            loadRuntime={async () => ({}) as GhosttyRuntime}
            onBeforeDispose={onBeforeDispose}
          />,
        );
      });
      await act(async () => {
        await flushMicrotasks();
      });
      act(() => {
        reactRoot.unmount();
      });
      expect(onBeforeDispose).not.toHaveBeenCalled();
      expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      createSpy.mockRestore();
      container.remove();
    }
  });

  it("still disposes terminal and clears host when onBeforeDispose throws", async () => {
    const events: string[] = [];
    const disposeSpy = vi.fn(() => {
      events.push("dispose");
    });
    const createSpy = vi.spyOn(Terminal, "create").mockImplementation(async () =>
      Object.assign(
        createMockPanelTerminal(new Set(), () => {}),
        { dispose: disposeSpy },
      ),
    );
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

    const container = document.createElement("div");
    document.body.appendChild(container);
    const reactRoot = createRoot(container);
    try {
      act(() => {
        reactRoot.render(
          <TerminalView
            adapter={adapter}
            sessionId="s1"
            loadRuntime={async () => ({}) as GhosttyRuntime}
            onTerminalReady={() => {}}
            onBeforeDispose={() => {
              events.push("before-dispose-throw");
              throw new Error("consumer capture error");
            }}
          />,
        );
      });
      await act(async () => {
        await flushMicrotasks();
      });
      expect(() => {
        act(() => {
          reactRoot.unmount();
        });
      }).toThrow("consumer capture error");
      expect(disposeSpy).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["detach", "before-dispose-throw", "dispose"]);
    } finally {
      createSpy.mockRestore();
      container.remove();
    }
  });

  it("focuses the primary terminal when clicking .wb-terminal-stage and ignores accessory buttons", async () => {
    const focusSpy = vi.fn();
    const createSpy = vi.spyOn(Terminal, "create").mockImplementation(async () =>
      Object.assign(
        createMockPanelTerminal(new Set(), () => {}),
        { focus: focusSpy },
      ),
    );
    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
      { id: "s1", title: "Shell 1", status: "ready" },
    ]);
    const activeId = createSubscribable<string | undefined>("s1");
    const splitId = createSubscribable<string | undefined>(undefined);
    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId,
      createSession: async () => "s1",
      closeSession: async () => {},
      selectSession: (id) => activeId.set(id),
      renameSession: () => {},
      toggleSplit: () => {},
      attach: async () => ({
        write: () => {},
        resize: () => {},
        detach: () => {},
      }),
    };

    try {
      const host = mount(
        <TerminalPanel adapter={adapter} showAccessoryBar loadRuntime={async () => ({}) as GhosttyRuntime} />,
      );
      await act(async () => {
        await flushMicrotasks();
      });

      const stage = host.querySelector<HTMLElement>(".wb-terminal-stage");
      expect(stage).not.toBeNull();
      act(() => {
        stage!.click();
      });
      expect(focusSpy).toHaveBeenCalledTimes(1);

      const accessoryButton = host.querySelector<HTMLButtonElement>(
        "[data-wb-terminal-accessory-bar] button",
      );
      expect(accessoryButton).not.toBeNull();
      act(() => {
        accessoryButton!.click();
      });
      expect(focusSpy).toHaveBeenCalledTimes(1);

      // SVG descendants inside interactive buttons/menus must also be ignored.
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      accessoryButton!.appendChild(svg);
      act(() => {
        svg.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(focusSpy).toHaveBeenCalledTimes(1);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("clears a pending split-pane focus request when clicking an already-mounted pane", async () => {
    const focus1 = vi.fn();
    const focus2 = vi.fn();
    let resolveSecondAttach!: () => void;
    let createCall = 0;
    const createSpy = vi.spyOn(Terminal, "create").mockImplementation(async () => {
      createCall += 1;
      return Object.assign(
        createMockPanelTerminal(new Set(), () => {}),
        { focus: createCall === 1 ? focus1 : focus2 },
      );
    });
    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
      { id: "s1", title: "Shell 1", status: "ready" },
      { id: "s2", title: "Shell 2", status: "ready" },
    ]);
    const activeId = createSubscribable<string | undefined>("s1");
    const splitId = createSubscribable<string | undefined>(undefined);
    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId,
      createSession: async () => "s1",
      closeSession: async () => {},
      selectSession: (id) => activeId.set(id),
      renameSession: () => {},
      toggleSplit: () => splitId.set("s2"),
      attach: async (id) => {
        if (id === "s2") {
          await new Promise<void>((resolve) => {
            resolveSecondAttach = resolve;
          });
        }
        return { write: () => {}, resize: () => {}, detach: () => {} };
      },
    };

    try {
      const host = mount(
        <TerminalPanel adapter={adapter} loadRuntime={async () => ({}) as GhosttyRuntime} />,
      );
      await act(async () => {
        await flushMicrotasks();
      });

      const splitButton = host.querySelector<HTMLButtonElement>('[data-testid="wb-term-split"]');
      expect(splitButton).not.toBeNull();
      act(() => {
        splitButton!.click();
      });
      await act(async () => {
        await flushMicrotasks();
      });

      const s1View = host.querySelector<HTMLElement>('[data-session-id="s1"]');
      expect(s1View).not.toBeNull();
      act(() => {
        s1View!.click();
      });
      expect(focus1).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveSecondAttach();
        await flushMicrotasks();
      });
      expect(focus2).not.toHaveBeenCalled();
    } finally {
      createSpy.mockRestore();
    }
  });

  it("attaches stripRef to .wb-terminal-strip-wrap and invokes React 19 ref cleanup on unmount", async () => {
    const createSpy = vi
      .spyOn(Terminal, "create")
      .mockImplementation(async () => createMockPanelTerminal(new Set(), () => {}));
    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
      { id: "s1", title: "Shell 1", status: "ready" },
    ]);
    const activeId = createSubscribable<string | undefined>("s1");
    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId: createSubscribable<string | undefined>(undefined),
      createSession: async () => "s1",
      closeSession: async () => {},
      selectSession: (id) => activeId.set(id),
      renameSession: () => {},
      toggleSplit: () => {},
      attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
    };

    const attachedNodes: HTMLDivElement[] = [];
    const cleanupSpy = vi.fn();
    const stripRef = (node: HTMLDivElement | null) => {
      if (node) attachedNodes.push(node);
      return cleanupSpy;
    };

    try {
      const host = mount(
        <TerminalPanel
          adapter={adapter}
          stripRef={stripRef}
          loadRuntime={async () => ({}) as GhosttyRuntime}
        />,
      );
      await act(async () => {
        await flushMicrotasks();
      });
      expect(attachedNodes).toHaveLength(1);
      expect(attachedNodes[0]?.classList.contains("wb-terminal-strip-wrap")).toBe(true);
      expect(host.querySelector(".wb-terminal-strip-wrap")).toBe(attachedNodes[0]);
      expect(cleanupSpy).not.toHaveBeenCalled();

      act(() => {
        activeRoot?.unmount();
        activeRoot = null;
      });
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    } finally {
      createSpy.mockRestore();
    }
  });

  it("applies 4-level fontSize precedence including live theme.fontSize updates on a mounted terminal", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const baseTheme = {
        colorScheme: "dark" as const,
        background: { r: 0, g: 0, b: 0 },
        foreground: { r: 255, g: 255, b: 255 },
        cursor: { r: 255, g: 255, b: 255 },
        cursorAccent: { r: 10, g: 10, b: 10 },
        selectionBackground: { r: 60, g: 60, b: 60 },
        selectionForeground: { r: 255, g: 255, b: 255 },
        ansi: Array.from({ length: 16 }, () => ({ r: 128, g: 128, b: 128 })),
        fontSize: 16,
      };
      const origMatchMedia = window.matchMedia;
      const setPhoneViewport = (phone: boolean) => {
        window.matchMedia = ((query: string) => ({
          matches: phone && query.includes("max-width"),
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        })) as typeof window.matchMedia;
      };
      try {
        setPhoneViewport(false);
        // Level 1: reactive Subscribable (fontSizeOverride) wins over theme.fontSize and numeric props.
        expect(
          resolveTerminalAppearance(host, { fontSizeOverride: 15, fontSize: 14, theme: baseTheme }).fontSize,
        ).toBe(15);
        // Level 2: theme.fontSize wins over numeric props and defaults when no reactive fontSizeOverride is passed.
        expect(resolveTerminalAppearance(host, { fontSize: 14, theme: baseTheme }).fontSize).toBe(16);
        // Level 3: numeric fontSize / mobileFontSize wins over defaults when no theme.fontSize is set.
        expect(resolveTerminalAppearance(host, { fontSize: 14, mobileFontSize: 11 }).fontSize).toBe(14);
        setPhoneViewport(true);
        expect(resolveTerminalAppearance(host, { fontSize: 14, mobileFontSize: 11 }).fontSize).toBe(11);
        // Level 4: built-in defaults (12 phone / 13 desktop).
        expect(resolveTerminalAppearance(host, {}).fontSize).toBe(12);
        setPhoneViewport(false);
        expect(resolveTerminalAppearance(host, {}).fontSize).toBe(13);
      } finally {
        window.matchMedia = origMatchMedia;
      }
    } finally {
      host.remove();
    }

    const setAppearanceSpy = vi.fn();
    const createSpy = vi.spyOn(Terminal, "create").mockImplementation(async () => {
      const mock = createMockPanelTerminal(new Set(), () => {});
      return Object.assign(mock, { setAppearance: setAppearanceSpy });
    });
    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
      { id: "s1", title: "Shell 1", status: "ready" },
    ]);
    const activeId = createSubscribable<string | undefined>("s1");
    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId: createSubscribable<string | undefined>(undefined),
      createSession: async () => "s1",
      closeSession: async () => {},
      selectSession: (id) => activeId.set(id),
      renameSession: () => {},
      toggleSplit: () => {},
      attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
    };

    const makeTheme = (fontSize: number) => ({
      colorScheme: "dark" as const,
      background: { r: 0, g: 0, b: 0 },
      foreground: { r: 255, g: 255, b: 255 },
      cursor: { r: 255, g: 255, b: 255 },
      cursorAccent: { r: 10, g: 10, b: 10 },
      selectionBackground: { r: 60, g: 60, b: 60 },
      selectionForeground: { r: 255, g: 255, b: 255 },
      ansi: Array.from({ length: 16 }, () => ({ r: 128, g: 128, b: 128 })),
      fontSize,
    });

    const themeSub = createSubscribable(makeTheme(15));

    try {
      mount(
        <TerminalPanel adapter={adapter} theme={themeSub} loadRuntime={async () => ({}) as GhosttyRuntime} />,
      );
      await act(async () => {
        await flushMicrotasks();
      });
      setAppearanceSpy.mockClear();

      // Updating theme.fontSize on an already-mounted terminal pushes the new font size live.
      act(() => {
        themeSub.set(makeTheme(18));
      });
      expect(setAppearanceSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          font: expect.objectContaining({ size: 18 }),
        }),
      );
    } finally {
      createSpy.mockRestore();
    }
  });

  it("renders paired split terminal tabs that keep the split active when selecting either half and rotates the collapse button chevron", async () => {
    const createSpy = vi
      .spyOn(Terminal, "create")
      .mockImplementation(async () => createMockPanelTerminal(new Set(), () => {}));
    const renamed: { readonly id: string; readonly title: string }[] = [];
    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
      { id: "s1", title: "Shell 1", status: "ready" },
      { id: "s2", title: "Shell 2", status: "ready" },
      { id: "s3", title: "Shell 3", status: "ready" },
    ]);
    const activeId = createSubscribable<string | undefined>("s1");
    const splitId = createSubscribable<string | undefined>("s2");
    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId,
      createSession: async () => "s4",
      closeSession: async (id) => {
        const next = sessions.getSnapshot().filter((s) => s.id !== id);
        sessions.set(next);
        if (splitId.getSnapshot() === id) splitId.set(undefined);
        if (activeId.getSnapshot() === id) activeId.set(next[0]?.id);
      },
      // Naive adapter sets activeId = id even when id === splitId; TerminalPanel must preserve the split pair!
      selectSession: (id) => activeId.set(id),
      renameSession: (id, title) => renamed.push({ id, title }),
      toggleSplit: () => splitId.set(splitId.getSnapshot() ? undefined : "s2"),
      attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
    };

    try {
      const host = mount(
        <TerminalPanel
          adapter={adapter}
          collapsed={false}
          onToggleCollapsed={vi.fn()}
          loadRuntime={async () => ({}) as GhosttyRuntime}
        />,
      );
      await act(async () => {
        await flushMicrotasks();
      });

      // Collapse button carries wb-terminal-collapse-btn and aria-expanded="true" when expanded.
      const collapseBtn = host.querySelector<HTMLButtonElement>('[data-testid="wb-term-collapse"]');
      expect(collapseBtn?.classList.contains("wb-terminal-collapse-btn")).toBe(true);
      expect(collapseBtn?.getAttribute("aria-expanded")).toBe("true");

      // Split pair renders inside one [data-wb-term-split-group] with no duplicate standalone tab for s2.
      const splitGroup = host.querySelector<HTMLElement>("[data-wb-term-split-group]");
      expect(splitGroup).not.toBeNull();
      expect(host.querySelectorAll('[data-testid="wb-term-tab-s2"]')).toHaveLength(1);
      expect(splitGroup?.querySelector('[data-testid="wb-term-tab-s1"]')).not.toBeNull();
      expect(splitGroup?.querySelector('[data-testid="wb-term-tab-s2"]')).not.toBeNull();
      expect(host.querySelectorAll("[data-wb-terminal]")).toHaveLength(2);

      // Clicking the right half tab notifies adapter.selectSession("s2") AND keeps the split active.
      const rightTabBtn = splitGroup!.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-s2"] button[role="tab"]',
      )!;
      act(() => {
        rightTabBtn.click();
      });
      expect(activeId.getSnapshot()).toBe("s2");
      expect(host.querySelector("[data-wb-term-split-group]")).not.toBeNull();
      expect(host.querySelectorAll("[data-wb-terminal]")).toHaveLength(2);
      expect(
        host.querySelector<HTMLElement>('[data-wb-terminal][data-session-id="s2"]')?.dataset.splitFocused,
      ).toBe("true");

      // Remounting with the SAME adapter state (activeId === splitId === "s2", no splitPair) preserves s1 + s2 with s2 focused!
      act(() => {
        activeRoot?.unmount();
        activeRoot = null;
      });
      const sameStateHost = mount(
        <TerminalPanel
          adapter={adapter}
          collapsed={false}
          onToggleCollapsed={vi.fn()}
          loadRuntime={async () => ({}) as GhosttyRuntime}
        />,
      );
      await act(async () => {
        await flushMicrotasks();
      });
      const sameStateGroup = sameStateHost.querySelector<HTMLElement>("[data-wb-term-split-group]");
      expect(sameStateGroup).not.toBeNull();
      expect(sameStateGroup?.querySelector('[data-testid="wb-term-tab-s1"]')).not.toBeNull();
      expect(sameStateGroup?.querySelector('[data-testid="wb-term-tab-s2"]')).not.toBeNull();
      expect(sameStateHost.querySelectorAll("[data-wb-terminal]")).toHaveLength(2);
      expect(
        sameStateHost.querySelector<HTMLElement>('[data-wb-terminal][data-session-id="s2"]')?.dataset
          .splitFocused,
      ).toBe("true");

      // Remounting after unmounting, CLOSING the split, reopening as s3 + s2, and selecting s2 while unmounted
      // restores s3 + s2 with s2 focused (never collapses to single s2 and never restores stale s1 + s2).
      act(() => {
        activeRoot?.unmount();
        activeRoot = null;
      });
      splitId.set(undefined);
      activeId.set("s3");
      splitId.set("s2");
      activeId.set("s2");
      const remountedHost = mount(
        <TerminalPanel
          adapter={adapter}
          collapsed={false}
          onToggleCollapsed={vi.fn()}
          loadRuntime={async () => ({}) as GhosttyRuntime}
        />,
      );
      await act(async () => {
        await flushMicrotasks();
      });
      const remountedGroup = remountedHost.querySelector<HTMLElement>("[data-wb-term-split-group]");
      expect(remountedGroup).not.toBeNull();
      expect(remountedGroup?.querySelector('[data-testid="wb-term-tab-s3"]')).not.toBeNull();
      expect(remountedGroup?.querySelector('[data-testid="wb-term-tab-s2"]')).not.toBeNull();
      expect(remountedGroup?.querySelector('[data-testid="wb-term-tab-s1"]')).toBeNull();
      expect(remountedHost.querySelectorAll("[data-wb-terminal]")).toHaveLength(2);
      expect(
        remountedHost.querySelector<HTMLElement>('[data-wb-terminal][data-session-id="s2"]')?.dataset
          .splitFocused,
      ).toBe("true");

      // Authoritative adapter.splitPair also survives remount with focused right half (activeId === splitId).
      const splitPairSub = createSubscribable<readonly [string, string] | undefined>(["s3", "s2"]);
      const deferredActiveId = createSubscribable<string | undefined>("s2");
      const deferredSplitId = createSubscribable<string | undefined>("s2");
      const deferredAdapter: TerminalAdapter = {
        ...adapter,
        activeId: deferredActiveId,
        splitId: deferredSplitId,
        splitPair: splitPairSub,
        selectSession: (id) => {
          queueMicrotask(() => {
            deferredActiveId.set(id);
            if (id !== "s2") splitPairSub.set([id, "s2"]);
          });
        },
      };
      act(() => {
        activeRoot?.unmount();
        activeRoot = null;
      });
      const deferredHost = mount(
        <TerminalPanel
          adapter={deferredAdapter}
          collapsed={false}
          onToggleCollapsed={vi.fn()}
          loadRuntime={async () => ({}) as GhosttyRuntime}
        />,
      );
      await act(async () => {
        await flushMicrotasks();
      });
      expect(
        deferredHost.querySelector<HTMLElement>('[data-wb-terminal][data-session-id="s2"]')?.dataset
          .splitFocused,
      ).toBe("true");

      // ArrowRight from s2 (right half) with TWO-STEP deferred async selectSession (activeId first, then splitPair regroup,
      // then unsplit) keeps keyboard focus on the live s1 button across every commit without dropping to <body>.
      const twoStepActiveId = createSubscribable<string | undefined>("s2");
      const twoStepSplitId = createSubscribable<string | undefined>("s2");
      const twoStepSplitPair = createSubscribable<readonly [string, string] | undefined>(["s3", "s2"]);
      let flushStep1: (() => void) | null = null;
      let flushStep2: (() => void) | null = null;
      let flushStep3: (() => void) | null = null;
      const twoStepAdapter: TerminalAdapter = {
        ...adapter,
        activeId: twoStepActiveId,
        splitId: twoStepSplitId,
        splitPair: twoStepSplitPair,
        selectSession: (id) => {
          flushStep1 = () => {
            twoStepActiveId.set(id);
          };
          flushStep2 = () => {
            twoStepSplitPair.set([id, "s2"]);
          };
          flushStep3 = () => {
            twoStepSplitId.set(undefined);
            twoStepSplitPair.set(undefined);
          };
        },
      };
      act(() => {
        activeRoot?.unmount();
        activeRoot = null;
      });
      const twoStepHost = mount(
        <div>
          <input data-testid="external-focus-target" />
          <TerminalPanel
            adapter={twoStepAdapter}
            collapsed={false}
            onToggleCollapsed={vi.fn()}
            loadRuntime={async () => ({}) as GhosttyRuntime}
          />
        </div>,
      );
      await act(async () => {
        await flushMicrotasks();
      });
      const twoStepRightTab = twoStepHost.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-s2"] button[role="tab"]',
      )!;
      const oldS1Tab = twoStepHost.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-s1"] button[role="tab"]',
      )!;
      act(() => {
        twoStepRightTab.focus();
        twoStepRightTab.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
        );
      });
      // Commit 1: activeId moves to s1 while split pair is still s3+s2.
      act(() => {
        flushStep1?.();
      });
      expect(document.activeElement).toBe(oldS1Tab);
      // Commit 2: split pair regroups to s1+s2, unmounting old standalone s1 button -> focus stays on new split-group s1 button.
      act(() => {
        flushStep2?.();
      });
      const groupedS1Tab = twoStepHost.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-s1"] button[role="tab"]',
      )!;
      expect(groupedS1Tab).not.toBe(oldS1Tab);
      expect(document.activeElement).toBe(groupedS1Tab);
      // Commit 3: split clears, unmounting split-group s1 button -> focus stays on new standalone s1 button.
      act(() => {
        flushStep3?.();
      });
      const standaloneS1Tab = twoStepHost.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-s1"] button[role="tab"]',
      )!;
      expect(standaloneS1Tab).not.toBe(groupedS1Tab);
      expect(document.activeElement).toBe(standaloneS1Tab);

      // Moving focus outside the panel BEFORE a deferred selectSession responds must NOT steal focus back.
      act(() => {
        twoStepActiveId.set("s3");
        twoStepSplitId.set("s2");
        twoStepSplitPair.set(["s3", "s2"]);
      });
      const externalInput = twoStepHost.querySelector<HTMLInputElement>(
        '[data-testid="external-focus-target"]',
      )!;
      const rightTabBeforeBlur = twoStepHost.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-s2"] button[role="tab"]',
      )!;
      act(() => {
        rightTabBeforeBlur.focus();
        rightTabBeforeBlur.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
        );
      });
      act(() => {
        externalInput.focus();
      });
      expect(document.activeElement).toBe(externalInput);
      act(() => {
        flushStep1?.();
        flushStep2?.();
      });
      expect(document.activeElement).toBe(externalInput);

      // Moving focus to another header button before a deferred selectSession responds also does NOT steal focus back.
      act(() => {
        twoStepActiveId.set("s3");
        twoStepSplitId.set("s2");
        twoStepSplitPair.set(["s3", "s2"]);
      });
      const newBtn = twoStepHost.querySelector<HTMLButtonElement>('[data-testid="wb-term-new"]')!;
      const rightTabBeforeHeaderMove = twoStepHost.querySelector<HTMLButtonElement>(
        '[data-testid="wb-term-tab-s2"] button[role="tab"]',
      )!;
      act(() => {
        rightTabBeforeHeaderMove.focus();
        rightTabBeforeHeaderMove.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
        );
      });
      act(() => {
        newBtn.focus();
      });
      expect(document.activeElement).toBe(newBtn);
      act(() => {
        flushStep1?.();
        flushStep2?.();
      });
      expect(document.activeElement).toBe(newBtn);

      // Select s2 again on standard adapter and verify Rename button targets the focused right half (s2).
      act(() => {
        activeRoot?.unmount();
        activeRoot = null;
      });
      activeId.set("s1");
      splitId.set("s2");
      const finalHost = mount(
        <TerminalPanel
          adapter={adapter}
          collapsed={false}
          onToggleCollapsed={vi.fn()}
          loadRuntime={async () => ({}) as GhosttyRuntime}
        />,
      );
      await act(async () => {
        await flushMicrotasks();
      });
      act(() => {
        finalHost
          .querySelector<HTMLButtonElement>('[data-testid="wb-term-tab-s2"] button[role="tab"]')
          ?.click();
      });
      act(() => {
        finalHost.querySelector<HTMLButtonElement>('[data-testid="wb-term-rename"]')?.click();
      });
      const renameInput = finalHost.querySelector<HTMLInputElement>(
        '[data-testid="wb-term-rename-input-s2"]',
      );
      expect(renameInput).not.toBeNull();
      act(() => {
        renameInput!.value = "Right pane";
        renameInput!.dispatchEvent(new Event("input", { bubbles: true }));
        renameInput!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      expect(renamed).toEqual([{ id: "s2", title: "Right pane" }]);

      // Closing the right half exits split cleanly.
      await act(async () => {
        finalHost
          .querySelector<HTMLButtonElement>('[data-testid="wb-term-tab-s2"] button[aria-label^="Close"]')
          ?.click();
        await flushMicrotasks();
      });
      expect(finalHost.querySelector("[data-wb-term-split-group]")).toBeNull();
      expect(finalHost.querySelectorAll("[data-wb-terminal]")).toHaveLength(1);

      // Collapsed state sets aria-expanded="false" for upward chevron rotation.
      act(() => {
        activeRoot?.render(
          <TerminalPanel
            adapter={adapter}
            collapsed={true}
            onToggleCollapsed={vi.fn()}
            loadRuntime={async () => ({}) as GhosttyRuntime}
          />,
        );
      });
      expect(
        finalHost
          .querySelector<HTMLButtonElement>('[data-testid="wb-term-collapse"]')
          ?.getAttribute("aria-expanded"),
      ).toBe("false");
    } finally {
      createSpy.mockRestore();
    }
  });

  it("routes TerminalAccessoryBar input to the focused split pane when keepAlive is false", async () => {
    const frameListeners = new Set<() => void>();
    const createSpy = vi
      .spyOn(Terminal, "create")
      .mockImplementation(async () => createMockPanelTerminal(frameListeners, () => {}));
    const written: string[] = [];
    const sessions = createSubscribable<readonly TerminalSessionInfo[]>([
      { id: "s1", title: "Shell 1", status: "ready" },
      { id: "s2", title: "Shell 2", status: "ready" },
    ]);
    const activeId = createSubscribable<string | undefined>("s1");
    const splitId = createSubscribable<string | undefined>("s2");
    const adapter: TerminalAdapter = {
      sessions,
      activeId,
      splitId,
      createSession: async () => "s3",
      closeSession: async () => {},
      selectSession: (id) => activeId.set(id),
      renameSession: () => {},
      toggleSplit: () => {},
      async attach(id, { onEvent }) {
        queueMicrotask(() => {
          onEvent({ type: "ready" });
          onEvent({ type: "replay-complete" });
        });
        return {
          write: (data) => written.push(`${id}:${data}`),
          resize: () => {},
          detach: () => {},
        };
      },
    };

    try {
      const host = mount(
        <TerminalPanel
          adapter={adapter}
          keepAlive={false}
          showAccessoryBar={true}
          loadRuntime={async () => ({}) as GhosttyRuntime}
        />,
      );
      await act(async () => {
        await flushMicrotasks();
        for (const onFrame of frameListeners) onFrame();
      });

      // Initially s1 is focused -> accessory bar renders on s1 and routes "|" to s1.
      expect(host.querySelectorAll("[data-wb-terminal-accessory-bar]")).toHaveLength(1);
      act(() => {
        host.querySelector<HTMLButtonElement>('[data-testid="wb-term-key-pipe"]')?.click();
      });
      expect(written).toEqual(["s1:|"]);

      // Selecting the right split tab s2 moves the accessory bar to s2 and routes "|" to s2.
      act(() => {
        host.querySelector<HTMLButtonElement>('[data-testid="wb-term-tab-s2"] button[role="tab"]')?.click();
      });
      expect(host.querySelectorAll("[data-wb-terminal]")).toHaveLength(2);
      expect(host.querySelectorAll("[data-wb-terminal-accessory-bar]")).toHaveLength(1);
      expect(
        host.querySelector<HTMLElement>('[data-wb-terminal][data-session-id="s2"]')?.dataset.splitFocused,
      ).toBe("true");
      act(() => {
        host.querySelector<HTMLButtonElement>('[data-testid="wb-term-key-pipe"]')?.click();
      });
      expect(written).toEqual(["s1:|", "s2:|"]);
    } finally {
      createSpy.mockRestore();
    }
  });
});
