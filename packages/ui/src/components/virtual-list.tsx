import { defaultRangeExtractor, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { observeWorkbenchTheme } from "@shaulavo/workbench-tokens";
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type Key,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { cx } from "../utils/cx";

export type VirtualListHandle = Pick<
  Virtualizer<HTMLDivElement, HTMLDivElement>,
  "scrollToIndex" | "scrollToOffset" | "measure" | "getTotalSize" | "getVirtualItems"
>;

export interface VirtualListProps<T> extends Omit<ComponentPropsWithoutRef<"div">, "children" | "ref"> {
  readonly items: readonly T[];
  readonly getKey: (item: T, index: number) => Key;
  readonly renderRow: (item: T, index: number) => ReactNode;
  readonly activeIndex?: number;
  readonly overscan?: number;
  readonly estimateSize?: (item: T, index: number, rowHeight: number) => number;
  readonly measureItems?: boolean;
  readonly initialRect?: { readonly width: number; readonly height: number };
  readonly scrollPaddingStart?: number;
  readonly scrollRef?: RefObject<HTMLDivElement | null>;
  readonly handleRef?: Ref<VirtualListHandle>;
  readonly contentClassName?: string;
  readonly onItemsRendered?: (range: { readonly startIndex: number; readonly endIndex: number }) => void;
}

const DEFAULT_ROW_HEIGHT = 26;

function readRowHeight(node: HTMLElement | null): number {
  if (!node || typeof window === "undefined") return DEFAULT_ROW_HEIGHT;
  const raw = getComputedStyle(node).getPropertyValue("--wb-tree-row-height").trim();
  if (!raw) return DEFAULT_ROW_HEIGHT;
  if (raw.endsWith("rem")) {
    const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const value = parseFloat(raw) * rootFont;
    return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_ROW_HEIGHT;
  }
  const px = parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? Math.round(px) : DEFAULT_ROW_HEIGHT;
}

function makeKeyReader<T>(items: readonly T[], getKey: (item: T, index: number) => Key) {
  return (index: number): Key => {
    const item = items[index];
    return item === undefined ? index : getKey(item, index);
  };
}

/**
 * Windowed list built on `@tanstack/react-virtual` that keeps `activeIndex` parked in the DOM,
 * tracks `--wb-tree-row-height` across density and coarse-pointer changes, and forwards scroll
 * handles cleanly.
 */
export function VirtualList<T>({
  items,
  getKey,
  renderRow,
  activeIndex,
  overscan = 10,
  estimateSize,
  measureItems = false,
  initialRect,
  scrollPaddingStart = 0,
  scrollRef,
  handleRef,
  className,
  contentClassName,
  onItemsRendered,
  ...props
}: VirtualListProps<T>) {
  // TanStack's mutable virtualizer must be read on every render without memoized snapshot staleness.
  "use no memo";

  const internalRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = scrollRef ?? internalRef;
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);

  useEffect(() => {
    const node = scrollerRef.current;
    const sync = (): void => setRowHeight(readRowHeight(scrollerRef.current));
    sync();
    window.addEventListener("resize", sync);
    const stopTheme = node ? observeWorkbenchTheme(node, sync) : undefined;
    return () => {
      window.removeEventListener("resize", sync);
      stopTheme?.();
    };
  }, [scrollerRef]);

  // Keep key identity bound to items so virtual-core does not discard cached measurements per render.
  // oxlint-disable-next-line react/exhaustive-deps
  const getItemKey = useMemo(() => makeKeyReader(items, getKey), [items]);

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (index) => {
      const item = items[index];
      return item === undefined ? rowHeight : (estimateSize?.(item, index, rowHeight) ?? rowHeight);
    },
    getItemKey,
    overscan,
    initialRect,
    scrollPaddingStart,
    rangeExtractor: (range) => {
      const indices = defaultRangeExtractor(range);
      if (
        activeIndex === undefined ||
        activeIndex < 0 ||
        activeIndex >= items.length ||
        indices.includes(activeIndex)
      ) {
        return indices;
      }
      return indices.concat([activeIndex]).sort((a, b) => a - b);
    },
  });

  const rows = virtualizer.getVirtualItems();
  const startIndex = rows[0]?.index ?? -1;
  const endIndex = rows.at(-1)?.index ?? -1;

  useImperativeHandle(handleRef, () => virtualizer, [virtualizer]);

  useLayoutEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  useLayoutEffect(() => {
    if (activeIndex === undefined || activeIndex < 0 || activeIndex >= items.length) return;
    virtualizer.scrollToIndex(activeIndex, { align: "auto" });
  }, [activeIndex, items.length, virtualizer]);

  useLayoutEffect(() => {
    onItemsRendered?.({ startIndex, endIndex });
  }, [startIndex, endIndex, onItemsRendered]);

  return (
    <div {...props} ref={scrollerRef} data-wb-virtual-list="" className={cx("wb-virtual-list", className)}>
      <div
        className={cx("wb-virtual-list-inner", contentClassName)}
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {rows.map((row) => {
          const item = items[row.index];
          if (item === undefined) return null;
          return (
            <div
              key={row.key}
              data-index={row.index}
              ref={measureItems ? virtualizer.measureElement : undefined}
              className="wb-virtual-list-row"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {renderRow(item, row.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
