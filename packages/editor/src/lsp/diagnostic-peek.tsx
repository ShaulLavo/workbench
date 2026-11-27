import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { LspHostAdapter, LspLocation } from "@shaulavo/workbench-core";
import { useSubscribable } from "@shaulavo/workbench-core/react";
import { StrokeIcon } from "@shaulavo/workbench-icons/react";
import { cx } from "@shaulavo/workbench-ui";

export interface DiagnosticPeekClientRect {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface DiagnosticPeekPlacement {
  readonly left: number;
  readonly top: number;
}

export interface DiagnosticPeekRelatedInfo {
  readonly label: string;
  readonly target: LspLocation;
}

export interface DiagnosticPeekModel {
  readonly severity: "error" | "warning" | "info" | "hint";
  readonly message: string;
  readonly source?: string;
  readonly code?: string;
  readonly geometry:
    | { readonly kind: "hidden" }
    | {
        readonly kind: "visible";
        readonly anchorRect: DiagnosticPeekClientRect;
        readonly clipRect: DiagnosticPeekClientRect;
      };
  readonly relatedInformation: readonly DiagnosticPeekRelatedInfo[];
}

export function copyDiagnosticPeekClientRect(rect: DiagnosticPeekClientRect): DiagnosticPeekClientRect {
  return Object.freeze({
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width,
  });
}

/** Positions `DiagnosticPeek` below or above its marker anchor while strictly clamping inside `clipRect`. */
export function diagnosticPeekPlacement(input: {
  readonly anchorRect: DiagnosticPeekClientRect;
  readonly clipRect: DiagnosticPeekClientRect;
  readonly layerRect: DiagnosticPeekClientRect;
  readonly surfaceHeight: number;
  readonly surfaceWidth: number;
  readonly gap?: number;
}): DiagnosticPeekPlacement {
  const gap = input.gap ?? 6;
  const below = input.anchorRect.bottom + gap;
  const above = input.anchorRect.top - gap - input.surfaceHeight;
  const maxTop = Math.max(input.clipRect.top, input.clipRect.bottom - input.surfaceHeight);

  let preferredTop: number;
  if (below >= input.clipRect.top && below + input.surfaceHeight <= input.clipRect.bottom) {
    preferredTop = below;
  } else if (above >= input.clipRect.top && above + input.surfaceHeight <= input.clipRect.bottom) {
    preferredTop = above;
  } else if (below < input.clipRect.top) {
    preferredTop = input.clipRect.top;
  } else {
    preferredTop = above;
  }

  const clientTop = Math.min(Math.max(preferredTop, input.clipRect.top), maxTop);
  const maxLeft = Math.max(input.clipRect.left, input.clipRect.right - input.surfaceWidth);
  const clientLeft = Math.min(Math.max(input.anchorRect.left, input.clipRect.left), maxLeft);
  return {
    left: clientLeft - input.layerRect.left,
    top: clientTop - input.layerRect.top,
  };
}

export interface DiagnosticPeekProps {
  readonly model: DiagnosticPeekModel;
  readonly onClose: (restoreOrigin: boolean) => void;
  readonly onOpenTarget?: (target: LspLocation) => void;
  readonly className?: string;
}

/** Accessible inline LSP diagnostic peek overlay positioned relative to its marker anchor. */
export function DiagnosticPeek({ model, onClose, onOpenTarget, className }: DiagnosticPeekProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const [placement, setPlacement] = useState<DiagnosticPeekPlacement | null>(null);
  const isVisible = model.geometry.kind === "visible";

  const emitClose = useEffectEvent((restoreOrigin: boolean) => {
    onClose(restoreOrigin);
  });

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const surface = surfaceRef.current;
    if (!layer || !surface || model.geometry.kind !== "visible") return;
    const geometry = model.geometry;

    const update = (): void => {
      setPlacement(
        diagnosticPeekPlacement({
          anchorRect: geometry.anchorRect,
          clipRect: geometry.clipRect,
          layerRect: copyDiagnosticPeekClientRect(layer.getBoundingClientRect()),
          surfaceHeight: surface.offsetHeight,
          surfaceWidth: surface.offsetWidth,
        }),
      );
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(layer);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [model]);

  // Focus dialog only on hidden -> visible transition so parent re-renders never steal focus.
  useEffect(() => {
    if (!isVisible) return;
    surfaceRef.current?.focus({ preventScroll: true });
  }, [isVisible]);

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    emitClose(true);
  }

  if (model.geometry.kind !== "visible") return null;

  const meta = [model.source, model.code].filter(Boolean).join(" · ");

  return (
    <div ref={layerRef} className={cx("wb-diagnostic-peek-layer", className)}>
      <div
        ref={surfaceRef}
        tabIndex={-1}
        role="dialog"
        aria-label={`${model.severity} diagnostic`}
        data-wb-diagnostic-peek=""
        data-severity={model.severity}
        data-testid="wb-diagnostic-peek"
        className={cx("wb-diagnostic-peek", !placement && "wb-diagnostic-peek-measuring")}
        style={placement ?? { left: 0, top: 0 }}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="wb-diagnostic-peek-header">
          <div className="wb-diagnostic-peek-body">
            <div className="wb-diagnostic-peek-severity">{model.severity}</div>
            <div className="wb-diagnostic-peek-message">{model.message}</div>
          </div>
          <button
            type="button"
            className="wb-diagnostic-peek-close"
            aria-label="Close diagnostic"
            data-testid="wb-diagnostic-peek-close"
            onClick={() => onClose(true)}
          >
            <StrokeIcon name="close" />
          </button>
        </div>

        {meta ? <div className="wb-diagnostic-peek-meta">{meta}</div> : null}

        {model.relatedInformation.length > 0 ? (
          <div className="wb-diagnostic-peek-related">
            {model.relatedInformation.map((info, index) => (
              <button
                key={`${info.target.path}:${info.target.line}:${info.target.column}:${index}`}
                type="button"
                className="wb-diagnostic-peek-related-btn"
                data-testid={`wb-diagnostic-related-${index}`}
                onClick={() => {
                  onClose(false);
                  onOpenTarget?.(info.target);
                }}
              >
                <span className="wb-diagnostic-peek-related-label">{info.label}</span>
                <span className="wb-diagnostic-peek-related-loc">
                  {info.target.path}:{info.target.line}:{info.target.column}
                </span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Compact status-bar indicator displaying active LSP server state and error/warning counts. */
export function LspStatusBadge({
  adapter,
  className,
}: {
  readonly adapter: LspHostAdapter;
  readonly className?: string;
}) {
  const status = useSubscribable(adapter.status);
  return (
    <span
      data-wb-lsp-status={status.state}
      data-testid="wb-lsp-status"
      className={cx("wb-lsp-status-badge", className)}
    >
      <span className="wb-lsp-status-label">{status.label ?? "LSP"}</span>
      <span className="wb-lsp-status-counts">
        {status.errorCount}E · {status.warningCount}W
      </span>
    </span>
  );
}
