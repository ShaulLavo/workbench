import { useState } from "react";
import type {
  HotkeyAdapter,
  Subscribable,
  TerminalAdapter,
  TerminalSessionInfo,
} from "@shaulavo/workbench-core";
import { useSubscribable } from "@shaulavo/workbench-core/react";
import { StrokeIcon } from "@shaulavo/workbench-icons/react";
import type { ThemeVersionSource } from "@shaulavo/workbench-tokens";
import { BarTab, BarTabStrip, cx, InlineRenameInput } from "@shaulavo/workbench-ui";
import type { Terminal } from "ghostty-webgpu";
import type { TerminalThemeInput } from "./theme";
import { TerminalView } from "./terminal-view";

export interface TerminalPanelProps {
  readonly adapter: TerminalAdapter;
  readonly active?: boolean;
  readonly themeOverride?: Subscribable<TerminalThemeInput>;
  readonly themeVersion?: ThemeVersionSource;
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
  readonly onTerminalReady?: (sessionId: string, terminal: Terminal) => void;
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
  onError,
  className,
}: TerminalPanelProps) {
  const sessions = useSubscribable(adapter.sessions);
  const activeId = useSubscribable(adapter.activeId);
  const splitId = useSubscribable(adapter.splitId);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const primarySession = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const secondarySession =
    splitId && primarySession && splitId !== primarySession.id
      ? sessions.find((s) => s.id === splitId)
      : undefined;

  return (
    <section data-wb-terminal-panel="" aria-label="Terminal" className={cx("wb-terminal-panel", className)}>
      <div className="wb-terminal-header">
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
                    onCommit={(next) => {
                      const trimmed = next.trim();
                      if (trimmed) adapter.renameSession(session.id, trimmed);
                      setRenamingId(null);
                    }}
                    onCancel={() => setRenamingId(null)}
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
                data-testid={`wb-term-tab-${session.id}`}
                onActivate={() => adapter.selectSession(session.id)}
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

        <div className="wb-terminal-actions">
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
            disabled={sessions.length < 2}
            onClick={() => adapter.toggleSplit(primarySession?.id)}
          >
            <StrokeIcon name="split" />
          </button>
        </div>
      </div>

      {primarySession ? (
        <div
          className={cx("wb-terminal-stage", secondarySession && "wb-terminal-stage-split")}
          data-split={secondarySession ? "true" : "false"}
        >
          <TerminalView
            key={primarySession.id}
            adapter={adapter}
            sessionId={primarySession.id}
            active={active}
            themeOverride={themeOverride}
            themeVersion={themeVersion}
            fontSize={fontSize}
            desktopFontSize={desktopFontSize}
            mobileFontSize={mobileFontSize}
            backgroundOpacity={backgroundOpacity}
            cursorBlink={cursorBlink}
            scrollbackLimit={scrollbackLimit}
            lowLatency={lowLatency}
            screenReader={screenReader}
            hotkeys={hotkeys}
            showAccessoryBar={showAccessoryBar}
            onTerminalReady={onTerminalReady ? (term) => onTerminalReady(primarySession.id, term) : undefined}
            onError={onError}
          />
          {secondarySession ? (
            <div className="wb-terminal-split-pane">
              <TerminalView
                key={secondarySession.id}
                adapter={adapter}
                sessionId={secondarySession.id}
                active={active}
                themeOverride={themeOverride}
                themeVersion={themeVersion}
                fontSize={fontSize}
                desktopFontSize={desktopFontSize}
                mobileFontSize={mobileFontSize}
                backgroundOpacity={backgroundOpacity}
                cursorBlink={cursorBlink}
                scrollbackLimit={scrollbackLimit}
                lowLatency={lowLatency}
                screenReader={screenReader}
                hotkeys={hotkeys}
                showAccessoryBar={false}
                onTerminalReady={
                  onTerminalReady ? (term) => onTerminalReady(secondarySession.id, term) : undefined
                }
                onError={onError}
              />
            </div>
          ) : null}
        </div>
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
