import {
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
  type UIEvent,
} from "react";
import { resolveActivationFocus, type ActivationFocusDecision } from "@shaulavo/workbench-core";
import { StrokeIcon } from "@shaulavo/workbench-icons/react";
import { cx } from "../utils/cx";

export interface BarTabStripProps extends ComponentPropsWithoutRef<"div"> {
  readonly label?: string;
  readonly actions?: ReactNode;
  readonly stripRef?: RefObject<HTMLDivElement | null>;
  readonly onStripScroll?: (event: UIEvent<HTMLDivElement>) => void;
}

function measureStripOverflow(element: HTMLDivElement | null): { start: boolean; end: boolean } {
  if (!element) return { start: false, end: false };
  return {
    start: element.scrollLeft > 1,
    end: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
  };
}

/** Horizontal scrollable tab strip sized to `--wb-bar-height` with optional trailing actions and overflow fade flags. */
export function BarTabStrip({
  label = "Open tabs",
  actions,
  stripRef,
  onStripScroll,
  className,
  children,
  ...props
}: BarTabStripProps) {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const resolvedRef = stripRef ?? internalRef;
  const [edges, setEdges] = useState<{ readonly start: boolean; readonly end: boolean }>({
    start: false,
    end: false,
  });

  function updateOverflow(): void {
    const next = measureStripOverflow(resolvedRef.current);
    setEdges((current) => (current.start === next.start && current.end === next.end ? current : next));
  }

  useEffect(() => {
    const element = resolvedRef.current;
    if (!element) return;
    const sync = () => {
      const next = measureStripOverflow(element);
      setEdges((current) => (current.start === next.start && current.end === next.end ? current : next));
    };
    queueMicrotask(sync);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    return () => observer.disconnect();
  }, [resolvedRef, children]);

  return (
    <div
      data-wb-tab-strip=""
      data-fade-start={edges.start ? "true" : undefined}
      data-fade-end={edges.end ? "true" : undefined}
      className={cx("wb-tab-strip-row", className)}
      {...props}
    >
      <div
        ref={resolvedRef}
        role="tablist"
        aria-label={label}
        className="wb-tab-strip"
        onScroll={(event) => {
          updateOverflow();
          onStripScroll?.(event);
        }}
      >
        {children}
      </div>
      {actions ? <div className="wb-tab-strip-actions">{actions}</div> : null}
    </div>
  );
}

export interface BarTabProps extends Omit<ComponentPropsWithoutRef<"div">, "onSelect"> {
  readonly active?: boolean;
  readonly label: string;
  readonly hint?: string;
  readonly title?: string;
  readonly icon?: ReactNode;
  readonly tone?: string;
  readonly preview?: boolean;
  readonly dirty?: boolean;
  readonly missing?: boolean;
  readonly dragging?: boolean;
  readonly dirtyTestId?: string;
  readonly closeLabel?: string;
  readonly tabRef?: Ref<HTMLDivElement>;
  readonly onActivate?: (focus: ActivationFocusDecision, event: MouseEvent<HTMLButtonElement>) => void;
  readonly onDoubleClickLabel?: () => void;
  readonly onTabKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  readonly onClose?: (event: MouseEvent<HTMLButtonElement>) => void;
}

/** Individual bar tab carrying optional language tone accent, hint, dirty dot, preview italic, missing state, and close button. */
export function BarTab({
  active = false,
  label,
  hint,
  title,
  icon,
  tone,
  preview = false,
  dirty = false,
  missing = false,
  dragging = false,
  dirtyTestId,
  closeLabel,
  tabRef,
  onActivate,
  onDoubleClickLabel,
  onTabKeyDown,
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
      ref={tabRef}
      data-wb-tab=""
      data-active={active ? "true" : "false"}
      data-preview={preview ? "true" : undefined}
      data-dirty={dirty ? "true" : undefined}
      data-missing={missing ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      data-tab-tone={tone}
      className={cx("wb-tab", className)}
      {...props}
    >
      <button
        type="button"
        role="tab"
        tabIndex={active ? 0 : -1}
        aria-selected={active}
        className="wb-tab-trigger"
        title={title ?? label}
        onClick={handleActivate}
        onDoubleClick={onDoubleClickLabel}
        onKeyDown={onTabKeyDown}
      >
        {icon ? (
          <span className="wb-tab-icon" aria-hidden="true">
            {icon}
          </span>
        ) : null}
        <span className="wb-tab-label">{label}</span>
        {hint ? <span className="wb-tab-hint">{hint}</span> : null}
        {dirty ? (
          <span className="wb-tab-dirty" role="img" aria-label="Unsaved changes" data-testid={dirtyTestId} />
        ) : null}
      </button>
      {onClose ? (
        <button
          type="button"
          tabIndex={-1}
          className="wb-tab-close"
          aria-label={resolvedCloseLabel}
          onPointerDown={(event) => event.stopPropagation()}
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
