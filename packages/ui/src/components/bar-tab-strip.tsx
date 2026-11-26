import type { ComponentPropsWithoutRef, MouseEvent, ReactNode } from "react";
import { resolveActivationFocus, type ActivationFocusDecision } from "@shaulavo/workbench-core";
import { StrokeIcon } from "@shaulavo/workbench-icons/react";
import { cx } from "../utils/cx";

export interface BarTabStripProps extends ComponentPropsWithoutRef<"div"> {
  readonly label?: string;
  readonly actions?: ReactNode;
}

/** Horizontal scrollable tab strip sized to `--wb-bar-height` with optional trailing actions. */
export function BarTabStrip({
  label = "Open tabs",
  actions,
  className,
  children,
  ...props
}: BarTabStripProps) {
  return (
    <div data-wb-tab-strip="" className={cx("wb-tab-strip-row", className)} {...props}>
      <div role="tablist" aria-label={label} className="wb-tab-strip">
        {children}
      </div>
      {actions ? <div className="wb-tab-strip-actions">{actions}</div> : null}
    </div>
  );
}

export interface BarTabProps extends Omit<ComponentPropsWithoutRef<"div">, "onSelect"> {
  readonly active?: boolean;
  readonly label: string;
  readonly title?: string;
  readonly icon?: ReactNode;
  readonly tone?: string;
  readonly preview?: boolean;
  readonly dirty?: boolean;
  readonly closeLabel?: string;
  readonly onActivate?: (focus: ActivationFocusDecision, event: MouseEvent<HTMLButtonElement>) => void;
  readonly onDoubleClickLabel?: () => void;
  readonly onClose?: (event: MouseEvent<HTMLButtonElement>) => void;
}

/** Individual bar tab carrying optional language tone accent, dirty dot, preview italic, and close button. */
export function BarTab({
  active = false,
  label,
  title,
  icon,
  tone,
  preview = false,
  dirty = false,
  closeLabel,
  onActivate,
  onDoubleClickLabel,
  onClose,
  className,
  ...props
}: BarTabProps) {
  const resolvedCloseLabel = closeLabel ?? `Close ${label}`;

  function handleActivate(event: MouseEvent<HTMLButtonElement>): void {
    const decision = resolveActivationFocus(event, "auto");
    onActivate?.(decision, event);
  }

  return (
    <div
      data-wb-tab=""
      data-active={active ? "true" : "false"}
      data-preview={preview ? "true" : undefined}
      data-dirty={dirty ? "true" : undefined}
      data-tab-tone={tone}
      className={cx("wb-tab", className)}
      {...props}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className="wb-tab-trigger"
        title={title ?? label}
        onClick={handleActivate}
        onDoubleClick={onDoubleClickLabel}
      >
        {icon ? (
          <span className="wb-tab-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="wb-tab-label">{label}</span>
        {dirty ? <span className="wb-tab-dirty" aria-label="Unsaved changes" /> : null}
      </button>
      {onClose ? (
        <button
          type="button"
          className="wb-tab-close"
          aria-label={resolvedCloseLabel}
          onClick={(event) => {
            event.stopPropagation();
            onClose(event);
          }}
        >
          <StrokeIcon name="close" />
        </button>
      ) : null}
    </div>
  );
}
