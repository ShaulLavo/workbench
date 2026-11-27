import { useEffect, useRef, useState, type ReactNode, type RefCallback } from "react";
import type {
  HotkeyAdapter,
  Subscribable,
  TerminalAdapter,
  TerminalAttachment,
  TerminalSessionInfo,
} from "@shaulavo/workbench-core";
import { useSubscribable } from "@shaulavo/workbench-core/react";
import { StrokeIcon } from "@shaulavo/workbench-icons/react";
import type { ThemeVersionSource } from "@shaulavo/workbench-tokens";
import { BarTab, BarTabStrip, cx, InlineRenameInput, type ContextMenuItem } from "@shaulavo/workbench-ui";
import type { Terminal } from "ghostty-webgpu";
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
  readonly themeOverride?: Subscribable<TerminalThemeInput>;
  readonly themeVersion?: ThemeVersionSource;
  readonly fontSize?: Subscribable<number>;
  readonly desktopFontSize?: number;
  readonly mobileFontSize?: number;
  readonly backgroundOpacity?: number;
  readonly cursorBlink?: boolean;
  readonly cursorInactiveStyle?: "outline" | "block" | "bar" | "underline" | "none" | "auto";
  readonly padding?: NonNullable<Parameters<typeof Terminal.create>[0]>["padding"];
  readonly scrollbackLimit?: number;
  readonly lowLatency?: boolean;
  readonly screenReader?: boolean;
  readonly hotkeys?: HotkeyAdapter;
  readonly showAccessoryBar?: boolean;
  readonly headerTrailing?: ReactNode;
  readonly tabStripRef?: RefCallback<HTMLDivElement>;
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

function SessionStatusDot({ status }: { readonly status: TerminalSessionInfo["status"] }) {
  return <span className="wb-terminal-status-dot" data-status={status} aria-label={`Terminal ${status}`} />;
}

/**
 * Multi-session terminal panel with session tabs, IME-safe inline tab rename, live status dot,
 * split pair support, and distinct view detach vs explicit session closure.
 */
export function TerminalPanel({
  adapter,
  active = true,
  collapsed = false,
  onToggleCollapsed,
  keepAlive = false,
  splitCreatesSession = false,
  themeOverride,
  themeVersion,
  fontSize,
  desktopFontSize,
  mobileFontSize,
  backgroundOpacity,
  cursorBlink = false,
  cursorInactiveStyle,
  padding,
  scrollbackLimit,
  lowLatency = false,
  screenReader = false,
  hotkeys,
  showAccessoryBar = false,
  headerTrailing,
  tabStripRef,
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
  const splitId = useSubscribable(adapter.splitId);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (renamingId !== null) return;
    const targetSessionId = restoreFocusSessionRef.current;
    if (!targetSessionId) return;
    restoreFocusSessionRef.current = null;
    const header = headerRef.current;
    if (!header) return;
    for (const tab of header.querySelectorAll<HTMLElement>("[data-wb-term-session]")) {
      if (tab.dataset.wbTermSession !== targetSessionId) continue;
      tab.querySelector<HTMLButtonElement>('button[role="tab"]')?.focus();
      return;
    }
  }, [renamingId]);

  const primarySession = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const secondarySession =
    splitId && primarySession && splitId !== primarySession.id
      ? sessions.find((s) => s.id === splitId)
      : undefined;

  function renderSessionView(
    session: TerminalSessionInfo,
    position: "single" | "left" | "right" | "hidden",
    showBar: boolean,
  ) {
    return (
      <TerminalView
        key={session.id}
        adapter={adapter}
        sessionId={session.id}
        active={active && !collapsed && position !== "hidden"}
        dataPosition={keepAlive ? position : undefined}
        themeOverride={themeOverride}
        themeVersion={themeVersion}
        fontSize={fontSize}
        desktopFontSize={desktopFontSize}
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
        showAccessoryBar={showBar}
        extraContextMenuItems={extraContextMenuItemsForSession?.(session.id)}
        onPointerDown={() => adapter.selectSession(session.id)}
        onTerminalReady={onTerminalReady ? (term) => onTerminalReady(session.id, term) : undefined}
        onAttached={onAttached ? (term, att) => onAttached(session.id, term, att) : undefined}
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

  return (
    <section
      data-wb-terminal-panel=""
      data-collapsed={collapsed ? "true" : "false"}
      aria-label="Terminal"
      className={cx("wb-terminal-panel", className)}
    >
      <div ref={headerRef} className="wb-terminal-header">
        <div ref={tabStripRef} className="wb-terminal-strip-wrap">
          <BarTabStrip label="Terminal sessions">
            {sessions.map((session) => {
              const isActive = session.id === primarySession?.id;
              const isRenaming = renamingId === session.id;
              if (isRenaming) {
                return (
                  <div key={session.id} className="wb-terminal-rename-tab">
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
              return (
                <BarTab
                  key={session.id}
                  active={isActive}
                  label={session.title}
                  tone="shell"
                  icon={<SessionStatusDot status={session.status} />}
                  data-wb-term-session={session.id}
                  data-testid={`wb-term-tab-${session.id}`}
                  onActivate={() => {
                    adapter.selectSession(session.id);
                    if (collapsed) onToggleCollapsed?.();
                  }}
                  onDoubleClickLabel={() => setRenamingId(session.id)}
                  onTabKeyDown={(event) => {
                    if (event.key !== "F2") return;
                    event.preventDefault();
                    setRenamingId(session.id);
                  }}
                  onClose={() => {
                    void adapter.closeSession(session.id);
                  }}
                />
              );
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
            disabled={!primarySession}
            onClick={() => {
              if (primarySession) setRenamingId(primarySession.id);
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
            onClick={() => {
              void adapter.createSession();
              if (collapsed) onToggleCollapsed?.();
            }}
          >
            <StrokeIcon name="plus" />
          </button>
          <button
            type="button"
            className="wb-terminal-action-btn"
            aria-label="Toggle split terminal"
            title="Toggle split terminal"
            aria-pressed={Boolean(secondarySession)}
            data-active={secondarySession ? "true" : undefined}
            data-testid="wb-term-split"
            disabled={splitCreatesSession ? false : sessions.length < 2}
            onClick={() => {
              adapter.toggleSplit(primarySession?.id);
              if (collapsed) onToggleCollapsed?.();
            }}
          >
            <StrokeIcon name="split" />
          </button>
          {onToggleCollapsed ? (
            <button
              type="button"
              className="wb-terminal-action-btn"
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

      {primarySession ? (
        <div
          className={cx("wb-terminal-stage", secondarySession && "wb-terminal-stage-split")}
          data-split={secondarySession ? "true" : "false"}
        >
          {keepAlive ? (
            sessions.map((session) => {
              const position =
                session.id === primarySession.id
                  ? secondarySession
                    ? "left"
                    : "single"
                  : session.id === secondarySession?.id
                    ? "right"
                    : "hidden";
              return renderSessionView(
                session,
                position,
                showAccessoryBar && session.id === primarySession.id,
              );
            })
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
      ) : renderEmpty ? (
        renderEmpty()
      ) : (
        <div className="wb-terminal-empty" data-testid="wb-terminal-empty">
          <p>No active terminal sessions.</p>
          <button
            type="button"
            className="wb-button wb-button-primary"
            data-testid="wb-term-empty-new"
            onClick={() => {
              void adapter.createSession();
            }}
          >
            New terminal
          </button>
        </div>
      )}
    </section>
  );
}
