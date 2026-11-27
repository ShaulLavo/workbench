import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { detectPlatform, type BrowserDispatcher, type FocusNode } from "@shaulavo/hotkeys";
import {
  createReplayGate,
  type HotkeyAdapter,
  type ReplayGate,
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
  readonly accessibilityLabel?: string;
  readonly padding?: NonNullable<Parameters<typeof Terminal.create>[0]>["padding"];
  /** `"auto"` uses `"outline"` on desktop viewports and solid cursor on phones. */
  readonly cursorInactiveStyle?: "outline" | "block" | "bar" | "underline" | "none" | "auto";
  readonly hotkeys?: HotkeyAdapter;
  readonly showAccessoryBar?: boolean;
  readonly disableContextMenu?: boolean;
  readonly extraContextMenuItems?: readonly ContextMenuItem[];
  readonly inertWhenNotReady?: boolean;
  readonly canvasHostClassName?: string;
  readonly dataPosition?: "single" | "left" | "right" | "hidden";
  readonly onTerminalReady?: (terminal: Terminal) => void;
  readonly onAttached?: (terminal: Terminal, attachment: TerminalAttachment) => void;
  readonly onReadyChange?: (ready: boolean) => void;
  readonly onFramePainted?: (terminal: Terminal) => void;
  readonly onScrollbackLengthChange?: (length: number) => void;
  readonly onTitleChange?: (title: string) => void;
  readonly onProcessChange?: (process: string | null) => void;
  readonly onExit?: (exitCode: number | null) => void;
  readonly onBell?: () => void;
  readonly onClear?: (terminal: Terminal, attachment: TerminalAttachment | null) => void;
  readonly onContextMenuCapture?: (event: MouseEvent<HTMLDivElement>, terminal: Terminal | null) => void;
  readonly onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  readonly renderError?: (message: string) => ReactNode;
  readonly onError?: (message: string, cause?: unknown) => void;
  readonly children?: ReactNode;
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

export interface TerminalStreamTarget {
  readonly gate: ReplayGate;
  readonly terminal: Pick<Terminal, "write" | "writeln" | "reset"> & {
    readonly appearance: { readonly grid: { readonly columns: number; readonly rows: number } };
  };
  readonly onResize: (cols: number, rows: number) => void;
  readonly onProcessChange?: (process: string | null) => void;
  readonly onTitleChange?: (title: string) => void;
  readonly onExit?: (exitCode: number | null) => void;
}

/** Dispatches one `TerminalStreamEvent` onto a terminal + `ReplayGate`, keeping reconnects alive. */
export function applyTerminalStreamEvent(event: TerminalStreamEvent, target: TerminalStreamTarget): void {
  if (event.type === "ready") {
    target.gate.begin();
    if (event.restoredHistory) {
      target.terminal.writeln("\r\n[Previous output restored. A new terminal process has started.]");
    }
    const grid = target.terminal.appearance.grid;
    target.onResize(grid.columns, grid.rows);
    return;
  }
  if (event.type === "output") {
    target.terminal.write(event.data);
    return;
  }
  if (event.type === "replay-complete") {
    target.gate.complete();
    return;
  }
  if (event.type === "cleared") {
    target.terminal.reset();
    return;
  }
  if (event.type === "process") {
    target.onProcessChange?.(event.name);
    return;
  }
  if (event.type === "title") {
    target.onTitleChange?.(event.title);
    return;
  }
  if (event.type === "exit") {
    target.terminal.writeln("");
    target.terminal.writeln(exitDetail(event.exitCode));
    target.onExit?.(event.exitCode);
    return;
  }
  if (event.type === "error") {
    target.terminal.writeln("");
    target.terminal.writeln(event.message);
    return;
  }
  if (event.type === "disconnected") {
    if (event.willReconnect) {
      // Recoverable disconnect disables input until the next ready -> replay-complete -> paint cycle.
      target.gate.begin();
    } else {
      target.gate.close();
    }
  }
}

export interface PasteClipboardSnapshotOptions {
  readonly targetTerminal: Pick<Terminal, "paste"> | null;
  readonly getCurrentTerminal: () => Pick<Terminal, "paste"> | null;
  readonly targetSessionId: string;
  readonly getCurrentSessionId: () => string;
  readonly isInputReady: () => boolean;
  readonly readClipboard: () => Promise<string | null>;
}

/**
 * Reads clipboard text and forwards it through Ghostty's `terminal.paste()` (preserving
 * bracketed-paste encoding), aborting if the terminal or active session changed mid-read.
 */
export async function pasteClipboardIntoTerminal(options: PasteClipboardSnapshotOptions): Promise<boolean> {
  if (!options.targetTerminal) return false;
  const text = await options.readClipboard();
  if (!text || !options.isInputReady()) return false;
  if (options.getCurrentTerminal() !== options.targetTerminal) return false;
  if (options.getCurrentSessionId() !== options.targetSessionId) return false;
  options.targetTerminal.paste(text);
  return true;
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
  accessibilityLabel,
  padding,
  cursorInactiveStyle,
  hotkeys,
  showAccessoryBar = false,
  disableContextMenu = false,
  extraContextMenuItems,
  inertWhenNotReady = false,
  canvasHostClassName,
  dataPosition,
  onTerminalReady,
  onAttached,
  onReadyChange,
  onFramePainted,
  onScrollbackLengthChange,
  onTitleChange,
  onProcessChange,
  onExit,
  onBell,
  onClear,
  onContextMenuCapture,
  onPointerDown,
  renderError,
  onError,
  children,
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
    accessibilityLabel,
    padding,
    cursorInactiveStyle,
    hotkeys,
    onTerminalReady,
    onAttached,
    onReadyChange,
    onFramePainted,
    onScrollbackLengthChange,
    onTitleChange,
    onProcessChange,
    onExit,
    onBell,
    onClear,
    onContextMenuCapture,
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
      accessibilityLabel,
      padding,
      cursorInactiveStyle,
      hotkeys,
      onTerminalReady,
      onAttached,
      onReadyChange,
      onFramePainted,
      onScrollbackLengthChange,
      onTitleChange,
      onProcessChange,
      onExit,
      onBell,
      onClear,
      onContextMenuCapture,
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

  function applyInactiveCursorStyle(terminal: Terminal | null): void {
    if (!terminal) return;
    const mode = propsRef.current.cursorInactiveStyle;
    if (!mode) return;
    if (mode === "auto") {
      const desktop = typeof matchMedia === "function" && matchMedia("(min-width: 769px)").matches;
      terminal.setCursorInactiveStyle(desktop ? "outline" : undefined);
      return;
    }
    terminal.setCursorInactiveStyle(mode === "none" ? undefined : mode);
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
      // Preserve accessibilityLabel in Ghostty's stored options so toggling screenReader on later retains it;
      // setAccessibilityEnabled(screenReader) immediately below enforces the current enabled state.
      const accessibility =
        current.accessibilityLabel !== undefined
          ? { label: current.accessibilityLabel }
          : current.screenReader
            ? {}
            : undefined;
      const nextTerminal = await Terminal.create({
        runtime: { kind: "borrowed", runtime },
        renderWhenOffscreen: true,
        presentation: lowLatency ? "immediate" : "frame",
        accessibility,
        padding: current.padding,
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
      applyInactiveCursorStyle(terminal);
      terminal.setAccessibilityEnabled(propsRef.current.screenReader);
      terminal.textarea?.setAttribute("aria-label", propsRef.current.accessibilityLabel ?? "Terminal input");

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
        const resolveFileLink = adapter.resolveFileLink.bind(adapter);
        const openFileLink = adapter.openFileLink.bind(adapter);
        const reg = registerTerminalFileLinks(terminal, {
          resolveFileLink,
          openFileLink,
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
          if (cancelled || signal.aborted || !terminal) return;
          gate.paint();
          attachment?.markRendered?.();
          propsRef.current.onFramePainted?.(terminal);
        }),
      );

      subs.push(
        terminal.onData(({ bytes }) => {
          if (bytes.byteLength === 0 || !inputReadyRef.current) return;
          if (attachment?.writeBytes) {
            attachment.writeBytes(bytes);
            return;
          }
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
        terminal.on("scroll", ({ scrollbar, scrollbackLength }) => {
          latestScrollRef.current = {
            total: scrollbar.total,
            length: scrollbar.length,
            offset: scrollbar.offset,
          };
          propsRef.current.onScrollbackLengthChange?.(scrollbackLength);
        }),
      );

      subs.push(
        terminal.on("title", (title) => {
          propsRef.current.onTitleChange?.(title);
        }),
      );

      subs.push(
        terminal.on("bell", () => {
          propsRef.current.onBell?.();
        }),
      );

      const handleStreamEvent = (event: TerminalStreamEvent): void => {
        if (cancelled || signal.aborted || !terminal) return;
        applyTerminalStreamEvent(event, {
          gate,
          terminal,
          onResize: (cols, rows) => {
            attachment?.resize(cols, rows);
          },
          onProcessChange: (process) => propsRef.current.onProcessChange?.(process),
          onTitleChange: (title) => propsRef.current.onTitleChange?.(title),
          onExit: (exitCode) => propsRef.current.onExit?.(exitCode),
        });
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
      // Re-sync appearance after async attach resolves so mid-boot theme toggles are reflected.
      syncAppearanceNow();
      const latestGrid = terminal.appearance.grid;
      if (latestGrid.columns !== grid.columns || latestGrid.rows !== grid.rows) {
        nextAttachment.resize(latestGrid.columns, latestGrid.rows);
      }
      propsRef.current.onAttached?.(terminal, nextAttachment);
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
    const onMediaChange = (): void => {
      syncAppearanceNow();
      applyInactiveCursorStyle(terminalRef.current);
    };
    media?.addEventListener("change", onMediaChange);
    syncAppearanceNow();
    applyInactiveCursorStyle(terminalRef.current);
    return () => {
      stopTheme();
      stopOverride?.();
      stopFont?.();
      media?.removeEventListener("change", onMediaChange);
    };
  }, [
    themeOverride,
    themeVersion,
    fontSize,
    desktopFontSize,
    mobileFontSize,
    backgroundOpacity,
    cursorBlink,
    cursorInactiveStyle,
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
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.setAccessibilityEnabled(screenReader);
    terminal.textarea?.setAttribute("aria-label", accessibilityLabel ?? "Terminal input");
  }, [screenReader, accessibilityLabel]);

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
    if (disableContextMenu) {
      propsRef.current.onContextMenuCapture?.(event, terminal);
      return;
    }
    if (!terminal) return;
    event.preventDefault();
    event.stopPropagation();
    propsRef.current.onContextMenuCapture?.(event, terminal);
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
        const targetTerminal = terminalRef.current;
        const targetSessionId = propsRef.current.sessionId;
        void pasteClipboardIntoTerminal({
          targetTerminal,
          getCurrentTerminal: () => terminalRef.current,
          targetSessionId,
          getCurrentSessionId: () => propsRef.current.sessionId,
          isInputReady: () => inputReadyRef.current,
          readClipboard: readClipboardText,
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
        const terminal = terminalRef.current;
        if (!terminal) return;
        if (propsRef.current.onClear) {
          propsRef.current.onClear(terminal, attachmentRef.current);
          return;
        }
        terminal.reset();
      },
    },
    ...(extraContextMenuItems ?? []),
  ];

  return (
    <div
      ref={wrapperRef}
      data-wb-terminal=""
      data-session-id={sessionId}
      data-position={dataPosition}
      data-ready={ready ? "true" : "false"}
      data-color-scheme={telemetry.scheme}
      data-background-opacity={String(telemetry.opacity)}
      data-font-size={String(telemetry.fontSize)}
      data-renderer-backend={telemetry.backend}
      className={cx("wb-terminal-view", telemetry.opacity === 0 && "wb-terminal-transparent", className)}
      onPointerDown={onPointerDown}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onContextMenuCapture={handleContextMenuCapture}
    >
      <div
        ref={hostRef}
        className={cx("wb-terminal-canvas-host", canvasHostClassName)}
        data-testid={`wb-terminal-host-${sessionId}`}
        inert={inertWhenNotReady && !ready ? true : undefined}
      />
      {errorMessage ? (
        renderError ? (
          renderError(errorMessage)
        ) : (
          <div className="wb-terminal-error" role="alert" data-testid="wb-terminal-error">
            {errorMessage}
          </div>
        )
      ) : null}
      {children}
      {showAccessoryBar ? (
        <TerminalAccessoryBar
          terminalRef={hostRef}
          onSendText={(text) => {
            if (inputReadyRef.current) attachmentRef.current?.write(text);
          }}
        />
      ) : null}
      {!disableContextMenu ? (
        <PointContextMenu
          open={contextMenu.open}
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems}
          label="Terminal actions"
          onOpenChange={(open) => setContextMenu((prev) => ({ ...prev, open }))}
        />
      ) : null}
    </div>
  );
}
