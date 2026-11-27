import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { observeWorkbenchTheme } from "@shaulavo/workbench-tokens";
import { computeStickyAncestors, type StickyAncestorsState, type TreeRow } from "../model";
import { StickyAncestorsOverlay } from "./sticky-ancestors";

const DEFAULT_ROW_HEIGHT = 26;
const SCROLL_IDLE_MS = 60;
const DRAG_EDGE_PX = 40;
const DRAG_MAX_SPEED_PX = 16;

function readTreeRowHeight(node: HTMLElement | null): number {
  if (!node || typeof window === "undefined") return DEFAULT_ROW_HEIGHT;
  const raw = getComputedStyle(node).getPropertyValue("--wb-tree-row-height").trim();
  if (!raw) return DEFAULT_ROW_HEIGHT;
  if (raw.endsWith("rem")) {
    const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const px = parseFloat(raw) * rootFont;
    return Number.isFinite(px) && px > 0 ? Math.round(px) : DEFAULT_ROW_HEIGHT;
  }
  const px = parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? Math.round(px) : DEFAULT_ROW_HEIGHT;
}

function makeKeyReader(rows: readonly TreeRow[]) {
  return (index: number): string => rows[index]?.key ?? String(index);
}

function stickyStackKey(rows: StickyAncestorsState["rows"]): string {
  return rows.map((row) => `${row.depth}:${row.path}:${row.name}`).join("\0");
}

function applyStickyPushUp(overlay: HTMLDivElement | null, pushUpPx: number): void {
  if (!overlay) return;
  overlay.style.transform = pushUpPx > 0 ? `translateY(${-pushUpPx}px)` : "";
}

export interface FileTreeViewportProps {
  readonly rows: readonly TreeRow[];
  readonly parkedIndices: readonly number[];
  readonly activeIndex: number;
  readonly scrollSeq: number;
  readonly scrollBehavior?: "auto" | "smooth";
  readonly scrollAlign?: "auto" | "start" | "center" | "end";
  readonly rowHeight?: number;
  readonly initialScrollTop?: number;
  readonly onScrollTopChange?: (scrollTop: number) => void;
  readonly scrollerRef?: RefObject<HTMLDivElement | null>;
  readonly hasEntryTabStop: boolean;
  readonly label: string;
  readonly focusModality: "pointer" | "keyboard";
  readonly iconPreset: "rich" | "stroke";
  readonly dragging: boolean;
  readonly touchDragging: boolean;
  readonly touchDragY: number | null;
  readonly directDomUpdates?: boolean;
  readonly renderRow: (row: TreeRow, index: number) => ReactNode;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onSelectStickyAncestor: (dirPath: string) => void;
  readonly onRootContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
  readonly onRootDragLeave?: (event: DragEvent<HTMLDivElement>) => void;
  readonly onRootDragOver?: (event: DragEvent<HTMLDivElement>) => void;
  readonly onRootDrop?: (event: DragEvent<HTMLDivElement>) => void;
}

/**
 * Windowed tree scroller wrapping `@tanstack/react-virtual` with parked focused/editing/dragged
 * rows, synchronous `data-is-scrolling` hover suppression, DOM-driven sticky ancestor push-up
 * (re-rendering React only when the sticky stack changes), and edge auto-scrolling during drags.
 */
export function FileTreeViewport({
  rows,
  parkedIndices,
  activeIndex,
  scrollSeq,
  scrollBehavior = "auto",
  scrollAlign = "auto",
  rowHeight: explicitRowHeight,
  initialScrollTop,
  onScrollTopChange,
  scrollerRef: externalScrollerRef,
  hasEntryTabStop,
  label,
  focusModality,
  iconPreset,
  dragging,
  touchDragging,
  touchDragY,
  directDomUpdates = false,
  renderRow,
  onKeyDown,
  onSelectStickyAncestor,
  onRootContextMenu,
  onRootDragLeave,
  onRootDragOver,
  onRootDrop,
}: FileTreeViewportProps) {
  // TanStack useVirtualizer returns a mutable instance read on every render.
  "use no memo";

  const internalScrollerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const stickyOverlayRef = useRef<HTMLDivElement | null>(null);
  const stickyKeyRef = useRef("");
  const stickyPushUpRef = useRef(0);
  const lastScrolledSeqRef = useRef(0);
  const appliedInitialScrollRef = useRef(false);
  const scrollTimerRef = useRef<number | undefined>(undefined);
  const dragPointerYRef = useRef<number | null>(null);
  const [measuredRowHeight, setMeasuredRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const rowHeight =
    explicitRowHeight !== undefined && explicitRowHeight > 0 ? explicitRowHeight : measuredRowHeight;
  const [stickyRows, setStickyRows] = useState<StickyAncestorsState["rows"]>([]);

  const attachScroller = useCallback(
    (node: HTMLDivElement | null) => {
      internalScrollerRef.current = node;
      if (externalScrollerRef) externalScrollerRef.current = node;
    },
    [externalScrollerRef],
  );

  const getItemKey = useMemo(() => makeKeyReader(rows), [rows]);
  const modeKey = directDomUpdates ? "direct" : "react";

  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => internalScrollerRef.current,
    estimateSize: () => rowHeight,
    // Fixed-height rows: register in elementsCache without triggering getBoundingClientRect reads.
    measureElement: directDomUpdates ? () => rowHeight : undefined,
    getItemKey,
    overscan: 12,
    directDomUpdates,
    directDomUpdatesMode: "transform",
    rangeExtractor: (range) => {
      const base = defaultRangeExtractor(range);
      if (parkedIndices.length === 0) return base;
      const merged = new Set(base);
      for (const idx of parkedIndices) {
        if (idx >= 0 && idx < rows.length) merged.add(idx);
      }
      return Array.from(merged).sort((a, b) => a - b);
    },
  });

  const attachCanvas = useCallback(
    (node: HTMLDivElement | null) => {
      canvasRef.current = node;
      virtualizer.containerRef(directDomUpdates ? node : null);
    },
    [directDomUpdates, virtualizer],
  );

  useEffect(() => {
    const node = internalScrollerRef.current;
    const sync = (): void => setMeasuredRowHeight(readTreeRowHeight(internalScrollerRef.current));
    sync();
    window.addEventListener("resize", sync);
    const stopTheme = node ? observeWorkbenchTheme(node, sync) : undefined;
    return () => {
      window.removeEventListener("resize", sync);
      stopTheme?.();
      if (scrollTimerRef.current !== undefined) window.clearTimeout(scrollTimerRef.current);
    };
  }, []);

  useLayoutEffect(() => {
    // React runs ref cleanup before detaching slot nodes; sweep once committed so unmounted slots are unobserved.
    virtualizer.measureElement(null);
    virtualizer.containerRef(directDomUpdates ? canvasRef.current : null);
  }, [directDomUpdates, virtualizer]);

  useLayoutEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  useLayoutEffect(() => {
    if (appliedInitialScrollRef.current) return;
    const node = internalScrollerRef.current;
    if (!node) return;
    appliedInitialScrollRef.current = true;
    if (initialScrollTop !== undefined && initialScrollTop > 0) {
      node.scrollTop = initialScrollTop;
      syncStickyFromScrollTop(initialScrollTop);
    }
    // oxlint-disable-next-line react/exhaustive-deps
  }, [initialScrollTop]);

  useLayoutEffect(() => {
    if (scrollSeq <= 0 || scrollSeq === lastScrolledSeqRef.current) return;
    if (activeIndex < 0 || activeIndex >= rows.length) return;
    lastScrolledSeqRef.current = scrollSeq;
    virtualizer.scrollToIndex(activeIndex, { align: scrollAlign, behavior: scrollBehavior });
  }, [activeIndex, scrollAlign, scrollBehavior, scrollSeq, rows.length, virtualizer]);

  useEffect(() => {
    if (touchDragY !== null) {
      dragPointerYRef.current = touchDragY;
    }
  }, [touchDragY]);

  // Edge auto-scroll animation loop while dragging over the top/bottom 40px edge zones.
  useEffect(() => {
    if (!dragging) {
      dragPointerYRef.current = null;
      return;
    }
    let frameId = 0;
    const step = (): void => {
      const node = internalScrollerRef.current;
      const y = dragPointerYRef.current;
      if (node && y !== null) {
        const rect = node.getBoundingClientRect();
        const topDist = y - rect.top;
        const bottomDist = rect.bottom - y;
        if (topDist >= 0 && topDist < DRAG_EDGE_PX) {
          const speed = Math.ceil(((DRAG_EDGE_PX - topDist) / DRAG_EDGE_PX) * DRAG_MAX_SPEED_PX);
          node.scrollTop = Math.max(0, node.scrollTop - speed);
        } else if (bottomDist >= 0 && bottomDist < DRAG_EDGE_PX) {
          const speed = Math.ceil(((DRAG_EDGE_PX - bottomDist) / DRAG_EDGE_PX) * DRAG_MAX_SPEED_PX);
          node.scrollTop += speed;
        }
      }
      frameId = requestAnimationFrame(step);
    };
    frameId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameId);
  }, [dragging]);

  function syncStickyFromScrollTop(scrollTop: number): void {
    const next = computeStickyAncestors(rows, scrollTop, rowHeight, 3);
    stickyPushUpRef.current = next.pushUpPx;
    applyStickyPushUp(stickyOverlayRef.current, next.pushUpPx);
    const nextKey = stickyStackKey(next.rows);
    if (nextKey !== stickyKeyRef.current) {
      stickyKeyRef.current = nextKey;
      setStickyRows(next.rows);
    }
  }

  useLayoutEffect(() => {
    syncStickyFromScrollTop(internalScrollerRef.current?.scrollTop ?? 0);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [rows, rowHeight]);

  function handleScroll(): void {
    const node = internalScrollerRef.current;
    if (!node) return;
    node.dataset.isScrolling = "true";
    if (scrollTimerRef.current !== undefined) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      scrollTimerRef.current = undefined;
      delete node.dataset.isScrolling;
    }, SCROLL_IDLE_MS);
    syncStickyFromScrollTop(node.scrollTop);
    onScrollTopChange?.(node.scrollTop);
  }

  const virtualRows = virtualizer.getVirtualItems();

  const wrapStyle =
    explicitRowHeight !== undefined && explicitRowHeight > 0
      ? ({ "--wb-tree-row-height": `${explicitRowHeight}px` } as CSSProperties)
      : undefined;

  return (
    <div className="wb-tree-viewport-wrap" style={wrapStyle}>
      <StickyAncestorsOverlay
        rows={stickyRows}
        initialPushUpPx={stickyPushUpRef.current}
        overlayRef={stickyOverlayRef}
        iconPreset={iconPreset}
        onSelectAncestor={(dirPath) => {
          const idx = rows.findIndex((r) => r.type === "entry" && r.path === dirPath);
          if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "start" });
          onSelectStickyAncestor(dirPath);
        }}
      />
      <div
        ref={attachScroller}
        role="tree"
        aria-label={label}
        aria-multiselectable="true"
        tabIndex={hasEntryTabStop ? -1 : 0}
        data-wb-tree-scroller=""
        data-focus-modality={focusModality}
        data-touch-dragging={touchDragging ? "true" : undefined}
        className="wb-tree-scroller"
        onScroll={handleScroll}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          if (!onRootContextMenu) return;
          if ((event.target as HTMLElement | null)?.closest("[data-wb-tree-row]")) return;
          event.preventDefault();
          onRootContextMenu(event);
        }}
        onDragLeave={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          dragPointerYRef.current = null;
          onRootDragLeave?.(event);
        }}
        onDragOverCapture={(event) => {
          dragPointerYRef.current = event.clientY;
        }}
        onDragOver={(event) => {
          dragPointerYRef.current = event.clientY;
          onRootDragOver?.(event);
        }}
        onDrop={(event) => {
          dragPointerYRef.current = null;
          onRootDrop?.(event);
        }}
      >
        <div
          ref={attachCanvas}
          className="wb-tree-canvas"
          style={directDomUpdates ? undefined : { height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualRows.map((vRow) => {
            const row = rows[vRow.index];
            if (!row) return null;
            return (
              <div
                key={`${modeKey}:${vRow.key}`}
                data-index={vRow.index}
                ref={directDomUpdates ? virtualizer.measureElement : undefined}
                className="wb-tree-slot"
                style={
                  directDomUpdates
                    ? { height: `${rowHeight}px` }
                    : { transform: `translateY(${vRow.start}px)`, height: `${rowHeight}px` }
                }
              >
                {renderRow(row, vRow.index)}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
