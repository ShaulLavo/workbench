import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "../utils/cx";
import { RenderErrorBoundary } from "./render-error-boundary";

export interface ToolPaneHeaderProps extends ComponentPropsWithoutRef<"div"> {
  readonly title?: string;
  readonly detail?: ReactNode;
  readonly actions?: ReactNode;
}

/** Standard header bar for a `ToolPane`, sized to `--wb-bar-height`. */
export function ToolPaneHeader({ title, detail, actions, className, ...props }: ToolPaneHeaderProps) {
  return (
    <div data-wb-tool-pane-header="" className={cx("wb-tool-pane-header", className)} {...props}>
      <div className="wb-tool-pane-heading">
        {title ? <span className="wb-tool-pane-title">{title}</span> : null}
        {detail ? <span className="wb-tool-pane-detail">{detail}</span> : null}
      </div>
      {actions ? <div className="wb-tool-pane-actions">{actions}</div> : null}
    </div>
  );
}

export interface ToolPaneState {
  readonly pending?: boolean;
  readonly error?: boolean;
  readonly empty?: boolean;
}

export interface ToolPaneProps extends Omit<ComponentPropsWithoutRef<"section">, "title"> {
  readonly title?: string;
  readonly detail?: ReactNode;
  readonly actions?: ReactNode;
  readonly header?: ReactNode;
  readonly subheader?: ReactNode;
  readonly state?: ToolPaneState;
  readonly loading?: ReactNode;
  readonly errorState?: ReactNode;
  readonly emptyState?: ReactNode;
  readonly resetKeys?: readonly unknown[];
  /** Set false when the body hosts its own scroller or terminal surface. */
  readonly scroll?: boolean;
  readonly bodyClassName?: string;
}

/**
 * Reusable workbench pane composing header, subheader, pending/error/empty branching, and an
 * isolated `RenderErrorBoundary`.
 */
export function ToolPane({
  title,
  detail,
  actions,
  header,
  subheader,
  state,
  loading,
  errorState,
  emptyState,
  resetKeys,
  scroll = true,
  bodyClassName,
  className,
  children,
  ...props
}: ToolPaneProps) {
  let content: ReactNode = children;
  if (state?.pending) {
    content = loading ?? (
      <div className="wb-pane-state" role="status" aria-live="polite">
        <span className="wb-spinner" aria-hidden="true" />
        <span>Loading {title ?? "content"}…</span>
      </div>
    );
  } else if (state?.error) {
    content = errorState ?? (
      <div className="wb-pane-state wb-pane-state-error" role="alert">
        <span>Unable to load {title ?? "content"}</span>
      </div>
    );
  } else if (state?.empty) {
    content = emptyState ?? (
      <div className="wb-pane-state">
        <span>No items</span>
      </div>
    );
  }

  return (
    <section data-wb-tool-pane="" className={cx("wb-tool-pane", className)} {...props}>
      {header === undefined ? <ToolPaneHeader title={title} detail={detail} actions={actions} /> : header}
      {subheader}
      <div
        data-wb-tool-pane-body=""
        data-scroll={scroll ? "true" : "false"}
        className={cx("wb-tool-pane-body", bodyClassName)}
      >
        <RenderErrorBoundary label={title ?? "This pane"} resetKeys={resetKeys}>
          {content}
        </RenderErrorBoundary>
      </div>
    </section>
  );
}
