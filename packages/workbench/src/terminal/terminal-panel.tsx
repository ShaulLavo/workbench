import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from "react";
import type {
  HotkeyAdapter,
  Subscribable,
  TerminalAdapter,
  TerminalAttachment,
  TerminalSessionInfo,
} from "../core/index";
import { useSubscribable } from "../core/react/index";
import { StrokeIcon } from "../icons/react";
import type { ThemeVersionSource } from "../tokens/index";
import { BarTab, BarTabStrip, cx, InlineRenameInput, type ContextMenuItem } from "../ui/index";
import type { GhosttyRuntime, Terminal } from "ghostty-webgpu";
import type { TerminalThemeInput } from "./theme";
import { TerminalView } from "./terminal-view";

export interface TerminalPanelProps {
  readonly adapter: TerminalAdapter;
  readonly active?: boolean;
  /** When true, hides the terminal stage while keeping the tab strip visible. */
  readonly collapsed?: boolean;
  readonly onToggleCollapsed?: () => void;
  /**
   * When true, keeps every open session's `TerminalView` mounted with `data-position`
   * (`"single" | "left" | "right" | "hidden"`) so in-browser WASM shells stay alive across tab switches.
   */
  readonly keepAlive?: boolean;
  /** When true, enables the Split button even with one session so `adapter.toggleSplit()` can spawn a second. */
  readonly splitCreatesSession?: boolean;
  readonly theme?: Subscribable<TerminalThemeInput>;
  readonly themeVersion?: ThemeVersionSource;
  readonly fontSize?: number | Subscribable<number>;
  readonly mobileFontSize?: number;
  readonly backgroundOpacity?: number;
  readonly cursorBlink?: boolean;
  readonly cursorInactiveStyle?: "outline" | "block" | "bar" | "underline" | "none" | "auto";
  readonly padding?: NonNullable<Parameters<typeof Terminal.create>[0]>["padding"];
  readonly scrollbackLimit?: number;
  readonly lowLatency?: boolean;
  readonly screenReader?: boolean;
  readonly hotkeys?: HotkeyAdapter;
  readonly onHotkeyError?: (cause: unknown, operation: string) => void;
  readonly loadRuntime?: (signal: AbortSignal) => Promise<GhosttyRuntime>;
  readonly onPasteFailed?: (sessionId: string, reason: "unavailable" | "denied") => void;
  readonly showAccessoryBar?: boolean;
  readonly headerTrailing?: ReactNode;
  /** Attached to `.wb-terminal-strip-wrap` (owns horizontal tab overflow & fade observers). */
  readonly stripRef?: Ref<HTMLDivElement>;
  readonly extraContextMenuItemsForSession?: (sessionId: string) => readonly ContextMenuItem[];
  readonly renderEmpty?: () => ReactNode;
  readonly onTerminalReady?: (sessionId: string, terminal: Terminal) => void;
  readonly onAttached?: (sessionId: string, terminal: Terminal, attachment: TerminalAttachment) => void;
  readonly onFramePainted?: (sessionId: string, terminal: Terminal) => void;
  readonly onTitleChange?: (sessionId: string, title: string) => void;
  readonly onProcessChange?: (sessionId: string, process: string | null) => void;
  readonly onExit?: (sessionId: string, exitCode: number | null) => void;
  readonly onBell?: (sessionId: string) => void;
  readonly onClear?: (sessionId: string, terminal: Terminal, attachment: TerminalAttachment | null) => void;
  readonly onError?: (message: string, cause?: unknown) => void;
  readonly className?: string;
}

const EMPTY_SPLIT_ID = {
  getSnapshot: (): string | undefined => undefined,
  subscribe: () => () => {},
};

const EMPTY_SPLIT_PAIR = {
  getSnapshot: (): readonly [string, string] | undefined => undefined,
  subscribe: () => () => {},
};

function SessionStatusDot({ status }: { readonly status: TerminalSessionInfo["status"] }) {
  return <span className="wb-terminal-status-dot" data-status={status} aria-label={`Terminal ${status}`} />;
}

function resolveTabNavTarget(
  sessions: readonly TerminalSessionInfo[],
  index: number,
  key: string,
): TerminalSessionInfo | undefined {
  if (sessions.length < 2) return undefined;
  if (key === "ArrowRight") return sessions[(index + 1) % sessions.length];
  if (key === "ArrowLeft") return sessions[(index - 1 + sessions.length) % sessions.length];
  if (key === "Home") return sessions[0];
  if (key === "End") return sessions.at(-1);
  return undefined;
}

function buildVisualTabOrder(
  sessions: readonly TerminalSessionInfo[],
  primary: TerminalSessionInfo | undefined,
  secondary: TerminalSessionInfo | undefined,
): readonly TerminalSessionInfo[] {
  if (!primary || !secondary) return sessions;
  const ordered: TerminalSessionInfo[] = [];
  for (const session of sessions) {
    if (session.id === secondary.id) continue;
    ordered.push(session);
    if (session.id === primary.id) ordered.push(secondary);
  }
  return ordered;
}

function resolveStageClickTarget(target: EventTarget | null, fallbackSessionId: string): string | null {
  if (!(target instanceof Element)) return fallbackSessionId;
  if (
    target.closest(
      "button, a, input, textarea, [role='menu'], [role='menuitem'], [data-wb-terminal-accessory-bar]",
    )
  ) {
    return null;
  }
  return target.closest<HTMLElement>("[data-session-id]")?.dataset.sessionId ?? fallbackSessionId;
}

function resolveSplitSessions(
  sessions: readonly TerminalSessionInfo[],
  activeId: string | undefined,
  splitId: string | undefined,
  splitPair: readonly [string, string] | undefined,
): {
  readonly primary: TerminalSessionInfo | undefined;
  readonly secondary: TerminalSessionInfo | undefined;
} {
  if (splitPair) {
    const left = sessions.find((s) => s.id === splitPair[0]);
    const right = sessions.find((s) => s.id === splitPair[1]);
    if (left && right && left.id !== right.id) {
      return { primary: left, secondary: right };
    }
  }
  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0];
  if (!splitId || !activeSession) {
    return { primary: activeSession, secondary: undefined };
  }
  const splitSession = sessions.find((s) => s.id === splitId);
  if (!splitSession || splitSession.id === activeSession.id) {
    return { primary: activeSession, secondary: undefined };
  }
  return { primary: activeSession, secondary: splitSession };
}

/**
 * Multi-session terminal panel with session tabs, paired split tab group, IME-safe inline tab
 * rename, live status dot, split pair support, and distinct view detach vs explicit session closure.
 */
export function TerminalPanel({
  adapter,
  active = true,
  collapsed = false,
  onToggleCollapsed,
  keepAlive = false,
  splitCreatesSession = false,
  theme,
  themeVersion,
  fontSize,
  mobileFontSize,
  backgroundOpacity,
  cursorBlink = false,
  cursorInactiveStyle,
  padding,
  scrollbackLimit,
  lowLatency = false,
  screenReader = false,
  hotkeys,
  onHotkeyError,
  loadRuntime,
  onPasteFailed,
  showAccessoryBar = false,
  headerTrailing,
  stripRef,
  extraContextMenuItemsForSession,
  renderEmpty,
  onTerminalReady,
  onAttached,
  onFramePainted,
  onTitleChange,
  onProcessChange,
  onExit,
  onBell,
  onClear,
  onError,
  className,
}: TerminalPanelProps) {
  const sessions = useSubscribable(adapter.sessions);
  const activeId = useSubscribable(adapter.activeId);
  const splitId = useSubscribable(adapter.splitId ?? EMPTY_SPLIT_ID);
  const splitPair = useSubscribable(adapter.splitPair ?? EMPTY_SPLIT_PAIR);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [focusTick, setFocusTick] = useState(0);
  const [tabFocusTick, setTabFocusTick] = useState(0);
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);

  const headerRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusSessionRef = useRef<string | null>(null);
  const pendingTabFocusRef = useRef<string | null>(null);
  const restoreFocusTargetRef = useRef<
    | { readonly closingId: string; readonly kind: "tab"; readonly id: string }
    | { readonly closingId: string; readonly kind: "new" }
    | null
  >(null);
  const pendingFocusRef = useRef<string | null>(null);
  const focusSeqRef = useRef(0);
  const terminalsByIdRef = useRef(new Map<string, Terminal>());

  const { primary: primarySession, secondary: secondarySession } = resolveSplitSessions(
    sessions,
    activeId,
    splitId,
    splitPair,
  );

  let focusedSession = primarySession;
  if (secondarySession) {
    const wantsSecondary =
      focusedPaneId === secondarySession.id || (focusedPaneId === null && activeId === secondarySession.id);
    if (wantsSecondary) focusedSession = secondarySession;
  }

  function selectSessionPreservingSplit(sessionId: string): void {
    setFocusedPaneId(sessionId);
    const isSecondaryWithoutPair =
      !adapter.splitPair && secondarySession !== undefined && sessionId === secondarySession.id;
    if (!isSecondaryWithoutPair) {
      adapter.selectSession(sessionId);
    }
  }

  function focusTabButton(targetSessionId: string): void {
    const header = headerRef.current;
    if (!header) return;
    for (const tab of header.querySelectorAll<HTMLElement>("[data-wb-term-session]")) {
      if (tab.dataset.wbTermSession !== targetSessionId) continue;
      tab.querySelector<HTMLButtonElement>('button[role="tab"]')?.focus();
      return;
    }
  }

  function requestTerminalFocus(sessionId: string | undefined): void {
    if (!sessionId) return;
    restoreFocusTargetRef.current = null;
    focusSeqRef.current += 1;
    pendingFocusRef.current = sessionId;
    if (terminalsByIdRef.current.has(sessionId)) {
      setFocusTick((tick) => tick + 1);
    }
  }

  function clearPendingTerminalFocus(): void {
    restoreFocusTargetRef.current = null;
    focusSeqRef.current += 1;
    pendingFocusRef.current = null;
  }

  function selectAndFocusSession(sessionId: string): void {
    pendingTabFocusRef.current = null;
    selectSessionPreservingSplit(sessionId);
    if (collapsed) onToggleCollapsed?.();
    requestTerminalFocus(sessionId);
  }

  function handleCreateSession(): void {
    pendingTabFocusRef.current = null;
    focusSeqRef.current += 1;
    const reqSeq = focusSeqRef.current;
    if (collapsed) onToggleCollapsed?.();
    void Promise.resolve(adapter.createSession()).then((id) => {
      if (focusSeqRef.current !== reqSeq || !id) return;
      setFocusedPaneId(id);
      requestTerminalFocus(id);
    });
  }

  useEffect(() => {
    if (renamingId !== null) return;
    const targetSessionId = restoreFocusSessionRef.current;
    if (!targetSessionId) return;
    restoreFocusSessionRef.current = null;
    focusTabButton(targetSessionId);
  }, [renamingId]);

  useEffect(() => {
    const activeIds = new Set(sessions.map((session) => session.id));
    for (const id of terminalsByIdRef.current.keys()) {
      if (!activeIds.has(id)) terminalsByIdRef.current.delete(id);
    }
    const pendingRestore = restoreFocusTargetRef.current;
    if (!pendingRestore || activeIds.has(pendingRestore.closingId)) return;
    restoreFocusTargetRef.current = null;
    const activeEl = document.activeElement;
    if (activeEl && activeEl !== document.body && !headerRef.current?.contains(activeEl)) return;
    if (pendingRestore.kind === "tab" && activeIds.has(pendingRestore.id)) {
      focusTabButton(pendingRestore.id);
      return;
    }
    const fallbackTab = sessions[0];
    if (fallbackTab) {
      focusTabButton(fallbackTab.id);
      return;
    }
    headerRef.current?.querySelector<HTMLButtonElement>('[data-testid="wb-term-new"]')?.focus();
  }, [sessions]);

  useEffect(() => {
    const targetId = pendingFocusRef.current;
    if (!targetId || collapsed || !active) return;
    const visible = targetId === primarySession?.id || targetId === secondarySession?.id;
    if (!visible) return;
    const term = terminalsByIdRef.current.get(targetId);
    if (!term) return;
    pendingFocusRef.current = null;
    term.focus();
  }, [focusTick, collapsed, active, primarySession?.id, secondarySession?.id]);

  function handleStageClick(event: MouseEvent<HTMLDivElement>): void {
    if (!primarySession || collapsed || !active) return;
    const fallbackId = focusedSession?.id ?? primarySession.id;
    const targetSessionId = resolveStageClickTarget(event.target, fallbackId);
    if (!targetSessionId) return;
    pendingTabFocusRef.current = null;
    setFocusedPaneId(targetSessionId);
    const terminal = terminalsByIdRef.current.get(targetSessionId);
    if (terminal) {
      clearPendingTerminalFocus();
      terminal.focus();
      return;
    }
    requestTerminalFocus(targetSessionId);
  }

  const orderedTabs = buildVisualTabOrder(sessions, primarySession, secondarySession);

  useLayoutEffect(() => {
    const targetId = pendingTabFocusRef.current;
    if (!targetId) return;
    focusTabButton(targetId);
    const settled = targetId === primarySession?.id || targetId === secondarySession?.id;
    if (settled) {
      pendingTabFocusRef.current = null;
    }
  }, [tabFocusTick, primarySession?.id, secondarySession?.id, activeId, splitId]);

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, sessionId: string): void {
    const index = orderedTabs.findIndex((session) => session.id === sessionId);
    if (event.key === "F2") {
      event.preventDefault();
      pendingTabFocusRef.current = null;
      setRenamingId(sessionId);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      pendingTabFocusRef.current = null;
      clearPendingTerminalFocus();
      const survivor = orderedTabs[index + 1] ?? orderedTabs[index - 1];
      restoreFocusTargetRef.current = survivor
        ? { closingId: sessionId, kind: "tab", id: survivor.id }
        : { closingId: sessionId, kind: "new" };
      void adapter.closeSession(sessionId);
      return;
    }
    const next = resolveTabNavTarget(orderedTabs, index, event.key);
    if (!next) return;
    event.preventDefault();
    clearPendingTerminalFocus();
    pendingTabFocusRef.current = next.id;
    setTabFocusTick((tick) => tick + 1);
    selectSessionPreservingSplit(next.id);
  }

  function renderSessionTab(session: TerminalSessionInfo, splitRole?: "left" | "right"): ReactNode {
    const isRenaming = renamingId === session.id;
    if (isRenaming) {
      return (
        <div
          key={session.id}
          className="wb-terminal-rename-tab"
          data-split-pane={splitRole}
          data-in-split={splitRole ? "true" : undefined}
        >
          <SessionStatusDot status={session.status} />
          <InlineRenameInput
            aria-label={`Rename ${session.title}`}
            initialValue={session.title}
            data-testid={`wb-term-rename-input-${session.id}`}
            onCommit={(next, reason) => {
              const trimmed = next.trim();
              if (trimmed) adapter.renameSession(session.id, trimmed);
              if (reason === "keyboard") restoreFocusSessionRef.current = session.id;
              setRenamingId(null);
            }}
            onCancel={() => {
              restoreFocusSessionRef.current = session.id;
              setRenamingId(null);
            }}
          />
        </div>
      );
    }

    const isFocused = focusedSession?.id === session.id;
    const isActiveTab = splitRole ? isFocused : session.id === primarySession?.id;
    return (
      <BarTab
        key={session.id}
        active={isActiveTab}
        label={session.title}
        tone="shell"
        icon={<SessionStatusDot status={session.status} />}
        data-wb-term-session={session.id}
        data-split-pane={splitRole}
        data-in-split={splitRole ? "true" : undefined}
        data-testid={`wb-term-tab-${session.id}`}
        onActivate={() => selectAndFocusSession(session.id)}
        onDoubleClickLabel={() => setRenamingId(session.id)}
        onTabKeyDown={(event) => handleTabKeyDown(event, session.id)}
        onClose={() => {
          void adapter.closeSession(session.id);
        }}
      />
    );
  }

  function renderSessionView(
    session: TerminalSessionInfo,
    position: "single" | "left" | "right" | "hidden",
    showBar: boolean,
  ) {
    const isSplit = Boolean(secondarySession);
    const isSplitFocused = isSplit && focusedSession?.id === session.id;
    return (
      <TerminalView
        key={session.id}
        adapter={adapter}
        sessionId={session.id}
        active={active && !collapsed && position !== "hidden"}
        dataPosition={keepAlive ? position : undefined}
        dataSplitFocused={isSplitFocused}
        theme={theme}
        themeVersion={themeVersion}
        fontSize={fontSize}
        mobileFontSize={mobileFontSize}
        backgroundOpacity={backgroundOpacity}
        cursorBlink={cursorBlink}
        cursorInactiveStyle={cursorInactiveStyle}
        padding={padding}
        scrollbackLimit={scrollbackLimit}
        lowLatency={lowLatency}
        screenReader={screenReader}
        accessibilityLabel={session.title}
        hotkeys={hotkeys}
        onHotkeyError={onHotkeyError}
        loadRuntime={loadRuntime}
        onPasteFailed={onPasteFailed ? (reason) => onPasteFailed(session.id, reason) : undefined}
        showAccessoryBar={showBar}
        extraContextMenuItems={extraContextMenuItemsForSession?.(session.id)}
        onPointerDown={() => {
          pendingTabFocusRef.current = null;
          selectSessionPreservingSplit(session.id);
        }}
        onTerminalReady={(term) => {
          terminalsByIdRef.current.set(session.id, term);
          onTerminalReady?.(session.id, term);
        }}
        onBeforeDispose={(term, sid) => {
          if (terminalsByIdRef.current.get(sid) === term) {
            terminalsByIdRef.current.delete(sid);
          }
        }}
        onAttached={(term, att) => {
          terminalsByIdRef.current.set(session.id, term);
          onAttached?.(session.id, term, att);
          if (pendingFocusRef.current === session.id && !collapsed && active && position !== "hidden") {
            pendingFocusRef.current = null;
            term.focus();
          }
        }}
        onFramePainted={onFramePainted ? (term) => onFramePainted(session.id, term) : undefined}
        onTitleChange={onTitleChange ? (title) => onTitleChange(session.id, title) : undefined}
        onProcessChange={onProcessChange ? (proc) => onProcessChange(session.id, proc) : undefined}
        onExit={onExit ? (code) => onExit(session.id, code) : undefined}
        onBell={onBell ? () => onBell(session.id) : undefined}
        onClear={onClear ? (term, att) => onClear(session.id, term, att) : undefined}
        onError={onError}
      />
    );
  }

  function resolveKeepAlivePosition(sessionId: string): "single" | "left" | "right" | "hidden" {
    if (sessionId === primarySession?.id) {
      return secondarySession ? "left" : "single";
    }
    if (sessionId === secondarySession?.id) {
      return "right";
    }
    return "hidden";
  }

  let stageContent: ReactNode;
  if (primarySession) {
    const orderedKeepAlive = [primarySession].concat(
      secondarySession ? [secondarySession] : [],
      sessions.filter((session) => session.id !== primarySession.id && session.id !== secondarySession?.id),
    );
    stageContent = (
      <div
        className={cx("wb-terminal-stage", secondarySession && "wb-terminal-stage-split")}
        data-split={secondarySession ? "true" : "false"}
        onClick={handleStageClick}
      >
        {keepAlive ? (
          orderedKeepAlive.map((session) =>
            renderSessionView(
              session,
              resolveKeepAlivePosition(session.id),
              showAccessoryBar && session.id === (focusedSession?.id ?? primarySession.id),
            ),
          )
        ) : (
          <>
            {renderSessionView(primarySession, secondarySession ? "left" : "single", showAccessoryBar)}
            {secondarySession ? (
              <div className="wb-terminal-split-pane">
                {renderSessionView(secondarySession, "right", false)}
              </div>
            ) : null}
          </>
        )}
      </div>
    );
  } else if (renderEmpty) {
    stageContent = renderEmpty();
  } else {
    stageContent = (
      <div className="wb-terminal-empty" data-testid="wb-terminal-empty">
        <p>No active terminal sessions.</p>
        <button
          type="button"
          className="wb-button wb-button-primary"
          data-testid="wb-term-empty-new"
          onClick={handleCreateSession}
        >
          New terminal
        </button>
      </div>
    );
  }

  return (
    <section
      data-wb-terminal-panel=""
      data-collapsed={collapsed ? "true" : "false"}
      aria-label="Terminal"
      className={cx("wb-terminal-panel", className)}
    >
      <div ref={headerRef} className="wb-terminal-header">
        <div ref={stripRef} className="wb-terminal-strip-wrap">
          <BarTabStrip label="Terminal sessions">
            {sessions.map((session) => {
              if (secondarySession && session.id === secondarySession.id) {
                return null;
              }
              if (secondarySession && primarySession && session.id === primarySession.id) {
                return (
                  <div
                    key={`split:${primarySession.id}:${secondarySession.id}`}
                    className="wb-terminal-split-group"
                    data-wb-term-split-group=""
                    data-active="true"
                  >
                    {renderSessionTab(primarySession, "left")}
                    <span className="wb-terminal-split-sep" aria-hidden="true" />
                    {renderSessionTab(secondarySession, "right")}
                  </div>
                );
              }
              return renderSessionTab(session);
            })}
          </BarTabStrip>
        </div>

        <div className="wb-terminal-actions">
          {headerTrailing}
          <button
            type="button"
            className="wb-terminal-action-btn"
            aria-label="Rename terminal"
            title="Rename terminal (F2)"
            data-testid="wb-term-rename"
            disabled={!focusedSession}
            onClick={() => {
              if (focusedSession) setRenamingId(focusedSession.id);
            }}
          >
            <svg aria-hidden="true" className="wb-stroke-icon" focusable="false" viewBox="0 0 24 24">
              <path d="M16.5 4.5 19.5 7.5 8 19H5v-3L16.5 4.5z" />
            </svg>
          </button>
          <button
            type="button"
            className="wb-terminal-action-btn"
            aria-label="New terminal"
            title="New terminal"
            data-testid="wb-term-new"
            onClick={handleCreateSession}
          >
            <StrokeIcon name="plus" />
          </button>
          <button
            type="button"
            className="wb-terminal-action-btn"
            aria-label={secondarySession ? "Unsplit terminal" : "Split terminal"}
            title={secondarySession ? "Unsplit terminal" : "Split terminal"}
            aria-pressed={Boolean(secondarySession)}
            data-active={secondarySession ? "true" : undefined}
            data-testid="wb-term-split"
            disabled={splitCreatesSession ? false : sessions.length < 2}
            onClick={() => {
              adapter.toggleSplit(focusedSession?.id ?? primarySession?.id);
              if (collapsed) onToggleCollapsed?.();
              const target = adapter.splitId.getSnapshot() ?? adapter.activeId.getSnapshot();
              if (target) setFocusedPaneId(target);
              requestTerminalFocus(target);
            }}
          >
            <StrokeIcon name="split" />
          </button>
          {onToggleCollapsed ? (
            <button
              type="button"
              className="wb-terminal-action-btn wb-terminal-collapse-btn"
              aria-label={collapsed ? "Expand terminal" : "Collapse terminal"}
              title={collapsed ? "Expand terminal" : "Collapse terminal"}
              aria-expanded={!collapsed}
              data-testid="wb-term-collapse"
              onClick={onToggleCollapsed}
            >
              <StrokeIcon name="chevron" />
            </button>
          ) : null}
        </div>
      </div>

      {stageContent}
    </section>
  );
}
