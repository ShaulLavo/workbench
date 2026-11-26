import type { MouseEvent, ReactNode } from "react";
import {
  dismissSoftKeyboardOnTouchActivation,
  resolveActivationFocus,
  type WorkbenchPaneId,
} from "@shaulavo/workbench-core";
import { cx } from "../utils/cx";

export interface MobilePaneItem {
  readonly id: WorkbenchPaneId;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly badge?: string | number;
  readonly content: ReactNode;
  /** When true, keeps inactive pane mounted (`hidden`) so terminals or webviews survive switches. */
  readonly keepMounted?: boolean;
}

export interface MobilePaneShellProps {
  readonly panes: readonly MobilePaneItem[];
  readonly activePane: WorkbenchPaneId;
  readonly onSelectPane: (pane: WorkbenchPaneId) => void;
  /** Collapses the bottom pane switcher while the mobile soft keyboard is visible. */
  readonly keyboardOpen?: boolean;
  readonly switcherLabel?: string;
  readonly className?: string;
}

/**
 * Single-pane phone shell respecting `--wb-keyboard-inset` and `env(safe-area-inset-bottom)`.
 * Collapses the bottom switcher while the soft keyboard is open and dismisses open touch
 * keyboards when switching panes.
 */
export function MobilePaneShell({
  panes,
  activePane,
  onSelectPane,
  keyboardOpen = false,
  switcherLabel = "Switch workbench pane",
  className,
}: MobilePaneShellProps) {
  function handleSwitch(paneId: WorkbenchPaneId, event: MouseEvent<HTMLButtonElement>): void {
    const decision = resolveActivationFocus(event, "never");
    dismissSoftKeyboardOnTouchActivation(decision, event.currentTarget);
    onSelectPane(paneId);
  }

  return (
    <div
      data-wb-mobile-shell=""
      data-keyboard-open={keyboardOpen ? "true" : "false"}
      className={cx("wb-mobile-shell", className)}
    >
      <div className="wb-mobile-viewport">
        {panes.map((pane) => {
          const isActive = pane.id === activePane;
          if (!isActive && !pane.keepMounted) return null;
          return (
            <div
              key={pane.id}
              role="tabpanel"
              data-wb-mobile-pane={pane.id}
              data-active={isActive ? "true" : "false"}
              className="wb-mobile-pane"
              hidden={!isActive}
            >
              {pane.content}
            </div>
          );
        })}
      </div>

      <nav
        role="tablist"
        aria-label={switcherLabel}
        data-wb-pane-switcher=""
        className="wb-pane-switcher"
        hidden={keyboardOpen}
      >
        {panes.map((pane) => {
          const isActive = pane.id === activePane;
          return (
            <button
              key={pane.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-active={isActive ? "true" : "false"}
              data-testid={`mobile-pane-${pane.id}`}
              className="wb-pane-switcher-btn"
              onClick={(event) => handleSwitch(pane.id, event)}
            >
              {pane.icon ? (
                <span className="wb-pane-switcher-icon" aria-hidden="true">
                  {pane.icon}
                </span>
              ) : null}
              <span className="wb-pane-switcher-label">{pane.label}</span>
              {pane.badge !== undefined ? <span className="wb-pane-switcher-badge">{pane.badge}</span> : null}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
