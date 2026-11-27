import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
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
  onRootDragOver,
  onRootDrop,
}: FileTreeViewportProps) {
  // TanStack useVirtualizer returns a mutable instance read on every render.
  "use no memo";

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickyOverlayRef = useRef<HTMLDivElement | null>(null);
  const stickyKeyRef = useRef("");
  const stickyPushUpRef = useRef(0);
  const scrollTimerRef = useRef<number | undefined>(undefined);
  const dragPointerYRef = useRef<number | null>(null);
  const lastScrolledSeqRef = useRef(0);
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);
  const [stickyRows, setStickyRows] = useState<StickyAncestorsState["rows"]>([]);

  useEffect(() => {
    const node = scrollerRef.current;
    const sync = (): void => setRowHeight(readTreeRowHeight(scrollerRef.current));
    sync();
    window.addEventListener("resize", sync);
    const stopTheme = node ? observeWorkbenchTheme(node, sync) : undefined;
    return () => {
      window.removeEventListener("resize", sync);
      stopTheme?.();
      if (scrollTimerRef.current !== undefined) window.clearTimeout(scrollTimerRef.current);
    };
  }, []);

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
      const node = scrollerRef.current;
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

  const getItemKey = useMemo(() => makeKeyReader(rows), [rows]);

  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
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
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  useLayoutEffect(() => {
    syncStickyFromScrollTop(scrollerRef.current?.scrollTop ?? 0);
    // oxlint-disable-next-line react/exhaustive-deps
  }, [rows, rowHeight]);

  useLayoutEffect(() => {
    if (scrollSeq <= 0 || scrollSeq === lastScrolledSeqRef.current) return;
    if (activeIndex < 0 || activeIndex >= rows.length) return;
    lastScrolledSeqRef.current = scrollSeq;
    virtualizer.scrollToIndex(activeIndex, { align: "auto" });
  }, [activeIndex, scrollSeq, rows.length, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();

  function handleScroll(): void {
    const node = scrollerRef.current;
    if (!node) return;
    node.dataset.isScrolling = "true";
    if (scrollTimerRef.current !== undefined) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      scrollTimerRef.current = undefined;
      delete node.dataset.isScrolling;
    }, SCROLL_IDLE_MS);
    syncStickyFromScrollTop(node.scrollTop);
  }

  return (
    <div className="wb-tree-viewport-wrap">
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
        ref={scrollerRef}
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
          ref={directDomUpdates ? virtualizer.containerRef : undefined}
          className="wb-tree-canvas"
          style={directDomUpdates ? undefined : { height: `${virtualizer.getTotalSize()}px` }}
        >
          {virtualRows.map((vRow) => {
            const row = rows[vRow.index];
            if (!row) return null;
            return (
              <div
                key={vRow.key}
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
