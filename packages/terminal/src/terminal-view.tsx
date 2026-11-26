import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent } from "react";
import { detectPlatform, type BrowserDispatcher, type FocusNode } from "@shaulavo/hotkeys";
import {
  createReplayGate,
  type HotkeyAdapter,
  type Subscribable,
  type TerminalAdapter,
  type TerminalAttachment,
  type TerminalSavedScroll,
  type TerminalStreamEvent,
} from "@shaulavo/workbench-core";
import { observeWorkbenchTheme, type ThemeVersionSource } from "@shaulavo/workbench-tokens";
import { cx, PointContextMenu, type ContextMenuItem } from "@shaulavo/workbench-ui";
import { Terminal, type GhosttyWebGpuTerminalSubscription } from "ghostty-webgpu";
import { attachTerminalHotkeys } from "ghostty-webgpu/hotkeys";
import { registerTerminalFileLinks } from "./links";
import { getSharedGhosttyRuntime } from "./runtime";
import { TerminalAccessoryBar } from "./terminal-accessory-bar";
import {
  applyTerminalAppearanceToInstance,
  resolveTerminalAppearance,
  terminalCursorOptions,
  type TerminalThemeInput,
} from "./theme";

export interface TerminalViewProps {
  readonly adapter: TerminalAdapter;
  readonly sessionId: string;
  readonly active?: boolean;
  /** Optional typed palette override (e.g. Fregat) bypassing CSS token probing. */
  readonly themeOverride?: Subscribable<TerminalThemeInput>;
  /** Optional invalidation signal when consumer updates a stylesheet without mutating attributes. */
  readonly themeVersion?: ThemeVersionSource;
  /** Optional reactive font-size override. */
  readonly fontSize?: Subscribable<number>;
  readonly desktopFontSize?: number;
  readonly mobileFontSize?: number;
  readonly backgroundOpacity?: number;
  readonly cursorBlink?: boolean;
  readonly scrollbackLimit?: number;
  readonly lowLatency?: boolean;
  readonly screenReader?: boolean;
  readonly hotkeys?: HotkeyAdapter;
  readonly showAccessoryBar?: boolean;
  readonly onTerminalReady?: (terminal: Terminal) => void;
  readonly onReadyChange?: (ready: boolean) => void;
  readonly onError?: (message: string, cause?: unknown) => void;
  readonly className?: string;
}

interface ContextMenuState {
  readonly open: boolean;
  readonly x: number;
  readonly y: number;
  readonly selectionText: string;
}

async function writeClipboardText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to execCommand copy below when Clipboard API is restricted.
    }
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  try {
    document.execCommand("copy");
  } finally {
    helper.remove();
  }
}

async function readClipboardText(): Promise<string | null> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }
  return null;
}

function isHostedHotkeyScope(
  value: unknown,
): value is { readonly dispatcher: BrowserDispatcher; readonly parent: FocusNode<KeyboardEvent> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "dispatcher" in value &&
    "parent" in value &&
    value.dispatcher !== undefined &&
    value.parent !== undefined
  );
}

function isSafeExternalUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function waitForDocumentFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.ready) return;
  try {
    await document.fonts.ready;
  } catch {
    // Proceed with fallback metrics if font readiness rejects.
  }
}

function exitDetail(exitCode: number | null): string {
  return exitCode === null ? "Process exited" : `Process exited (${exitCode})`;
}

/**
 * Ghostty WebGPU React 19 terminal view with shared borrowed runtime, ordered attach/replay
 * `ReplayGate`, reactive CSS-token and typed-palette theme/font sync across startup races and
 * pane reattachment, capture-phase context menu with selection snapshot, workspace file links,
 * and optional mobile hardware-key accessory bar.
 */
export function TerminalView({
  adapter,
  sessionId,
  active = true,
  themeOverride,
  themeVersion,
  fontSize,
  desktopFontSize,
  mobileFontSize,
  backgroundOpacity,
  cursorBlink = false,
  scrollbackLimit,
  lowLatency = false,
  screenReader = false,
  hotkeys,
  showAccessoryBar = false,
  onTerminalReady,
  onReadyChange,
  onError,
  className,
}: TerminalViewProps) {
  // Imperative Ghostty WASM canvas host wrapper: retains terminal across Fast Refresh and async handovers.
  "use no memo";

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const attachmentRef = useRef<TerminalAttachment | null>(null);
  const inputReadyRef = useRef(false);
  const focusedRef = useRef(false);
  const latestScrollRef = useRef<TerminalSavedScroll | null>(null);

  const propsRef = useRef({
    adapter,
    sessionId,
    themeOverride,
    fontSize,
    desktopFontSize,
    mobileFontSize,
    backgroundOpacity,
    cursorBlink,
    screenReader,
    hotkeys,
    onTerminalReady,
    onReadyChange,
    onError,
  });
  useLayoutEffect(() => {
    propsRef.current = {
      adapter,
      sessionId,
      themeOverride,
      fontSize,
      desktopFontSize,
      mobileFontSize,
      backgroundOpacity,
      cursorBlink,
      screenReader,
      hotkeys,
      onTerminalReady,
      onReadyChange,
      onError,
    };
  });

  const [ready, setReady] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<{
    readonly scheme: string;
    readonly opacity: number;
    readonly fontSize: number;
    readonly backend: string;
  }>({
    scheme: "dark",
    opacity: backgroundOpacity ?? 1,
    fontSize: desktopFontSize ?? 13,
    backend: "pending",
  });
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    open: false,
    x: 0,
    y: 0,
    selectionText: "",
  });

  function syncAppearanceNow(): void {
    const terminal = terminalRef.current;
    const host = hostRef.current;
    if (!terminal || !host) return;
    const current = propsRef.current;
    const resolved = resolveTerminalAppearance(host, {
      override: current.themeOverride?.getSnapshot(),
      fontSizeOverride: current.fontSize?.getSnapshot(),
      desktopFontSize: current.desktopFontSize,
      mobileFontSize: current.mobileFontSize,
      backgroundOpacity: current.backgroundOpacity,
      cursorBlink: current.cursorBlink,
    });
    applyTerminalAppearanceToInstance(terminal, resolved, focusedRef.current);
    setTelemetry({
      scheme: resolved.colorScheme,
      opacity: resolved.backgroundOpacity,
      fontSize: resolved.fontSize,
      backend: terminal.diagnostics.rendererBackend ?? "unknown",
    });
  }

  // Primary Ghostty mount + ordered stream attachment lifecycle (StrictMode-safe).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const controller = new AbortController();
    const { signal } = controller;
    let cancelled = false;
    let terminal: Terminal | null = null;
    let attachment: TerminalAttachment | null = null;
    let hotkeyCleanup: (() => void) | null = null;
    let linkCleanup: (() => void) | null = null;
    const subs: GhosttyWebGpuTerminalSubscription[] = [];
    const decoder = new TextDecoder();

    setReady(false);
    setErrorMessage(null);
    inputReadyRef.current = false;
    latestScrollRef.current = null;

    const open = async (): Promise<void> => {
      await waitForDocumentFonts();
      if (cancelled || signal.aborted) return;

      const runtime = await getSharedGhosttyRuntime();
      if (cancelled || signal.aborted) return;

      const current = propsRef.current;
      const nextTerminal = await Terminal.create({
        runtime: { kind: "borrowed", runtime },
        renderWhenOffscreen: true,
        presentation: lowLatency ? "immediate" : "frame",
        accessibility: current.screenReader ? {} : undefined,
        links: {
          activateUri: (uri: string) => {
            if (!isSafeExternalUri(uri)) return;
            const latestAdapter = propsRef.current.adapter;
            if (latestAdapter.openExternalUrl) {
              latestAdapter.openExternalUrl(uri);
            } else {
              window.open(uri, "_blank", "noopener,noreferrer");
            }
          },
        },
        appearance: {
          backgroundOpacity: current.backgroundOpacity ?? (current.themeOverride ? 0 : 1),
          cursor: { blink: false, style: "outline" },
          scrollbackLimit,
        },
      });
      if (cancelled || signal.aborted) {
        nextTerminal.dispose();
        return;
      }

      terminal = nextTerminal;
      await terminal.open(host);
      if (cancelled || signal.aborted) {
        terminal.dispose();
        terminal = null;
        return;
      }

      terminalRef.current = terminal;

      // Read latest appearance at async handover BEFORE first paint so startup races never stick.
      syncAppearanceNow();
      terminal.setAccessibilityEnabled(propsRef.current.screenReader);

      if (propsRef.current.hotkeys) {
        const parentScope = propsRef.current.hotkeys.getTerminalParentScope?.();
        const conn = isHostedHotkeyScope(parentScope)
          ? attachTerminalHotkeys(terminal, {
              mode: "hosted",
              dispatcher: parentScope.dispatcher,
              parent: parentScope.parent,
              platform: detectPlatform(),
            })
          : attachTerminalHotkeys(terminal, {
              mode: "standalone",
              platform: detectPlatform(),
            });
        hotkeyCleanup = () => conn.dispose();
      }

      if (adapter.resolveFileLink && adapter.openFileLink) {
        const reg = registerTerminalFileLinks(terminal, {
          resolveFileLink: (rawPath) => propsRef.current.adapter.resolveFileLink!(rawPath),
          openFileLink: (path, location, focus) =>
            propsRef.current.adapter.openFileLink!(path, location, focus),
        });
        linkCleanup = () => reg.dispose();
      }

      const gate = createReplayGate({
        terminal: {
          scrollBy: (delta) => {
            terminal?.scrollBy(delta);
          },
          refresh: (startRow, endRow) => {
            terminal?.refresh(startRow, endRow);
          },
          getRowCount: () => terminal?.appearance.grid.rows ?? 0,
        },
        getSavedScroll: () => propsRef.current.adapter.getSavedScroll?.(sessionId) ?? null,
        onReadyChange: (isReady) => {
          if (cancelled || signal.aborted) return;
          inputReadyRef.current = isReady;
          setReady(isReady);
          propsRef.current.onReadyChange?.(isReady);
        },
      });

      subs.push(
        terminal.onFrame(() => {
          if (cancelled || signal.aborted) return;
          gate.paint();
        }),
      );

      subs.push(
        terminal.onData(({ bytes }) => {
          if (bytes.byteLength === 0 || !inputReadyRef.current) return;
          const text = decoder.decode(bytes, { stream: true });
          if (text) attachment?.write(text);
        }),
      );

      subs.push(
        terminal.onResize(({ cols, rows }) => {
          attachment?.resize(cols, rows);
        }),
      );

      subs.push(
        terminal.on("scroll", ({ scrollbar }) => {
          latestScrollRef.current = {
            total: scrollbar.total,
            length: scrollbar.length,
            offset: scrollbar.offset,
          };
        }),
      );

      const handleStreamEvent = (event: TerminalStreamEvent): void => {
        if (cancelled || signal.aborted || !terminal) return;
        if (event.type === "ready") {
          gate.begin();
          if (event.restoredHistory) {
            terminal.writeln("\r\n[Previous output restored. A new terminal process has started.]");
          }
          const grid = terminal.appearance.grid;
          attachment?.resize(grid.columns, grid.rows);
          return;
        }
        if (event.type === "output") {
          terminal.write(event.data);
          return;
        }
        if (event.type === "replay-complete") {
          gate.complete();
          return;
        }
        if (event.type === "cleared") {
          terminal.reset();
          return;
        }
        if (event.type === "exit") {
          terminal.writeln("");
          terminal.writeln(exitDetail(event.exitCode));
          return;
        }
        if (event.type === "error") {
          terminal.writeln("");
          terminal.writeln(event.message);
          return;
        }
        if (event.type === "disconnected") {
          gate.close();
        }
      };

      const grid = terminal.appearance.grid;
      propsRef.current.onTerminalReady?.(terminal);
      const nextAttachment = await adapter.attach(sessionId, {
        initialSize: { cols: grid.columns, rows: grid.rows },
        signal,
        onEvent: handleStreamEvent,
      });
      if (cancelled || signal.aborted) {
        nextAttachment.detach();
        return;
      }
      attachment = nextAttachment;
      attachmentRef.current = nextAttachment;
      const latestGrid = terminal.appearance.grid;
      if (latestGrid.columns !== grid.columns || latestGrid.rows !== grid.rows) {
        nextAttachment.resize(latestGrid.columns, latestGrid.rows);
      }
    };

    void open().catch((cause: unknown) => {
      if (cancelled || signal.aborted) return;
      const msg = cause instanceof Error ? cause.message : "Unable to initialize terminal";
      setErrorMessage(msg);
      propsRef.current.onError?.(msg, cause);
    });

    return () => {
      cancelled = true;
      controller.abort();
      if (latestScrollRef.current) {
        propsRef.current.adapter.saveScroll?.(sessionId, latestScrollRef.current);
      }
      for (const sub of subs) sub.dispose();
      subs.length = 0;
      hotkeyCleanup?.();
      linkCleanup?.();
      // View detach NEVER kills the underlying PTY session.
      attachment?.detach();
      attachmentRef.current = null;
      terminal?.dispose();
      terminalRef.current = null;
      inputReadyRef.current = false;
      host.replaceChildren();
    };
  }, [adapter, sessionId, scrollbackLimit, lowLatency]);

  // Reactive theme, viewport font size, and optional typed-override subscriptions.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const stopTheme = observeWorkbenchTheme(host, syncAppearanceNow, { themeVersion });
    const stopOverride = themeOverride?.subscribe(syncAppearanceNow);
    const stopFont = fontSize?.subscribe(syncAppearanceNow);
    const media = typeof matchMedia === "function" ? matchMedia("(max-width: 768px)") : undefined;
    media?.addEventListener("change", syncAppearanceNow);
    syncAppearanceNow();
    return () => {
      stopTheme();
      stopOverride?.();
      stopFont?.();
      media?.removeEventListener("change", syncAppearanceNow);
    };
  }, [
    themeOverride,
    themeVersion,
    fontSize,
    desktopFontSize,
    mobileFontSize,
    backgroundOpacity,
    cursorBlink,
  ]);

  // Re-read and reapply current appearance whenever a pane becomes active again after collapse/switch.
  useEffect(() => {
    if (!active) return;
    syncAppearanceNow();
    const terminal = terminalRef.current;
    if (terminal && terminal.appearance.grid.rows > 0) {
      terminal.refresh(0, terminal.appearance.grid.rows - 1);
    }
  }, [active]);

  useEffect(() => {
    terminalRef.current?.setAccessibilityEnabled(screenReader);
  }, [screenReader]);

  function handleFocus(): void {
    focusedRef.current = true;
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.setCursor(terminalCursorOptions(true, cursorBlink));
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>): void {
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    focusedRef.current = false;
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.setCursor(terminalCursorOptions(false, cursorBlink));
  }

  // Capture phase intercepts contextmenu before Ghostty's target-phase handler and snapshots selection.
  function handleContextMenuCapture(event: MouseEvent<HTMLDivElement>): void {
    const terminal = terminalRef.current;
    if (!terminal) return;
    event.preventDefault();
    event.stopPropagation();
    const selectionText = terminal.getSelection() ?? "";
    setContextMenu({
      open: true,
      x: event.clientX,
      y: event.clientY,
      selectionText,
    });
  }

  const menuItems: readonly ContextMenuItem[] = [
    {
      id: "copy",
      label: "Copy",
      hint: "⌘C",
      disabled: contextMenu.selectionText.length === 0,
      testId: "wb-term-ctx-copy",
      onSelect: () => {
        if (contextMenu.selectionText) {
          void writeClipboardText(contextMenu.selectionText);
        }
      },
    },
    {
      id: "paste",
      label: "Paste",
      hint: "⌘V",
      testId: "wb-term-ctx-paste",
      onSelect: () => {
        void readClipboardText().then((text) => {
          if (text && inputReadyRef.current) attachmentRef.current?.write(text);
        });
      },
    },
    {
      id: "select-all",
      label: "Select all",
      separatorBefore: true,
      testId: "wb-term-ctx-select-all",
      onSelect: () => {
        terminalRef.current?.selectAll();
      },
    },
    {
      id: "clear",
      label: "Clear terminal",
      separatorBefore: true,
      testId: "wb-term-ctx-clear",
      onSelect: () => {
        terminalRef.current?.reset();
      },
    },
  ];

  return (
    <div
      ref={wrapperRef}
      data-wb-terminal=""
      data-session-id={sessionId}
      data-ready={ready ? "true" : "false"}
      data-color-scheme={telemetry.scheme}
      data-background-opacity={String(telemetry.opacity)}
      data-font-size={String(telemetry.fontSize)}
      data-renderer-backend={telemetry.backend}
      className={cx("wb-terminal-view", telemetry.opacity === 0 && "wb-terminal-transparent", className)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onContextMenuCapture={handleContextMenuCapture}
    >
      <div ref={hostRef} className="wb-terminal-canvas-host" data-testid={`wb-terminal-host-${sessionId}`} />
      {errorMessage ? (
        <div className="wb-terminal-error" role="alert" data-testid="wb-terminal-error">
          {errorMessage}
        </div>
      ) : null}
      {showAccessoryBar ? (
        <TerminalAccessoryBar
          terminalRef={hostRef}
          onSendText={(text) => {
            if (inputReadyRef.current) attachmentRef.current?.write(text);
          }}
        />
      ) : null}
      <PointContextMenu
        open={contextMenu.open}
        x={contextMenu.x}
        y={contextMenu.y}
        items={menuItems}
        label="Terminal actions"
        onOpenChange={(open) => setContextMenu((prev) => ({ ...prev, open }))}
      />
    </div>
  );
}
