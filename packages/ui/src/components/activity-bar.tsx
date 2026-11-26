import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "../utils/cx";

export interface ActivityBarItem {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly active?: boolean;
  readonly badge?: string | number;
  readonly shortcutHint?: string;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export interface ActivityBarProps extends ComponentPropsWithoutRef<"nav"> {
  readonly items: readonly ActivityBarItem[];
  readonly footer?: ReactNode;
  readonly label?: string;
}

/** Vertical workbench rail sized to `--wb-rail-width` with accessible toggle buttons. */
export function ActivityBar({
  items,
  footer,
  label = "Workbench views",
  className,
  ...props
}: ActivityBarProps) {
  return (
    <nav aria-label={label} data-wb-activity-bar="" className={cx("wb-activity-bar", className)} {...props}>
      <div className="wb-activity-bar-items">
        {items.map((item) => {
          const tooltip = item.shortcutHint ? `${item.label} (${item.shortcutHint})` : item.label;
          return (
            <button
              key={item.id}
              type="button"
              className="wb-activity-item"
              aria-label={item.label}
              aria-pressed={Boolean(item.active)}
              data-active={item.active ? "true" : "false"}
              data-wb-tooltip={tooltip}
              data-testid={`activity-${item.id}`}
              disabled={item.disabled}
              onClick={item.onSelect}
            >
              <span className="wb-activity-icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.badge !== undefined ? <span className="wb-activity-badge">{item.badge}</span> : null}
            </button>
          );
        })}
      </div>
      {footer ? <div className="wb-activity-bar-footer">{footer}</div> : null}
    </nav>
  );
}
