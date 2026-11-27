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
  type CSSProperties,
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

export type VirtualListLayoutMode = "absolute" | "flow";

export interface VirtualListProps<T> extends Omit<ComponentPropsWithoutRef<"div">, "children" | "ref"> {
  readonly items: readonly T[];
  readonly getKey: (item: T, index: number) => Key;
  readonly renderRow: (item: T, index: number) => ReactNode;
  readonly activeIndex?: number;
  readonly overscan?: number;
  readonly estimateSize?: (item: T, index: number, rowHeight: number) => number;
  readonly measureItems?: boolean;
  /** Positioning mode. `flow` keeps normal document flow (Plan 181); `absolute` positions rows with transforms. */
  readonly layout?: VirtualListLayoutMode;
  /**
   * Enables `@tanstack/react-virtual` direct DOM updates on `layout="absolute"` to skip React
   * re-renders during scroll-only ticks. Defaults to `true` for measured absolute lists
   * (`measureItems: true`) where A/B scroll measurements cut React commits and render time;
   * always forced `false` for `layout="flow"` (Plan 181).
   */
  readonly directDomUpdates?: boolean;
  readonly initialRect?: { readonly width: number; readonly height: number };
  readonly initialMeasurementsCache?: Virtualizer<HTMLDivElement, HTMLDivElement>["measurementsCache"];
  readonly initialOffset?: number;
  readonly paddingStart?: number;
  readonly paddingEnd?: number;
  readonly scrollMargin?: number;
  readonly scrollPaddingStart?: number;
  readonly anchorTo?: "start" | "end";
  readonly scrollEndThreshold?: number;
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

interface VirtualListInnerProps<T> {
  readonly scrollerRef: RefObject<HTMLDivElement | null>;
  readonly rowHeight: number;
  readonly items: readonly T[];
  readonly getKey: (item: T, index: number) => Key;
  readonly renderRow: (item: T, index: number) => ReactNode;
  readonly activeIndex?: number;
  readonly overscan: number;
  readonly estimateSize?: (item: T, index: number, rowHeight: number) => number;
  readonly measureItems: boolean;
  readonly layout: VirtualListLayoutMode;
  readonly effectiveDirectDom: boolean;
  readonly initialRect?: { readonly width: number; readonly height: number };
  readonly initialMeasurementsCache?: Virtualizer<HTMLDivElement, HTMLDivElement>["measurementsCache"];
  readonly initialOffset?: number;
  readonly paddingStart: number;
  readonly paddingEnd: number;
  readonly scrollMargin: number;
  readonly scrollPaddingStart: number;
  readonly anchorTo?: "start" | "end";
  readonly scrollEndThreshold?: number;
  readonly handleRef?: Ref<VirtualListHandle>;
  readonly contentClassName?: string;
  readonly onItemsRendered?: (range: { readonly startIndex: number; readonly endIndex: number }) => void;
}

/**
 * Keyed per `(layout, effectiveDirectDom)` so switching positioning modes at runtime always
 * mounts a fresh TanStack virtualizer and clean DOM container without stale inline styles.
 */
function VirtualListInner<T>({
  scrollerRef,
  rowHeight,
  items,
  getKey,
  renderRow,
  activeIndex,
  overscan,
  estimateSize,
  measureItems,
  layout,
  effectiveDirectDom,
  initialRect,
  initialMeasurementsCache,
  initialOffset,
  paddingStart,
  paddingEnd,
  scrollMargin,
  scrollPaddingStart,
  anchorTo,
  scrollEndThreshold,
  handleRef,
  contentClassName,
  onItemsRendered,
}: VirtualListInnerProps<T>) {
  // TanStack's mutable virtualizer must be read on every render without memoized snapshot staleness.
  "use no memo";

  // Keep key identity bound to items so virtual-core does not discard cached measurements per render.
  // oxlint-disable-next-line react/exhaustive-deps
  const getItemKey = useMemo(() => makeKeyReader(items, getKey), [items]);

  const readEstimatedSize = (index: number): number => {
    const item = items[index];
    return item === undefined ? rowHeight : (estimateSize?.(item, index, rowHeight) ?? rowHeight);
  };

  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: items.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: readEstimatedSize,
    // For fixed-height directDomUpdates lists, register nodes in elementsCache without getBoundingClientRect reads.
    measureElement:
      effectiveDirectDom && !measureItems
        ? (node) => readEstimatedSize(Number(node.getAttribute("data-index")))
        : undefined,
    getItemKey,
    overscan,
    directDomUpdates: effectiveDirectDom,
    directDomUpdatesMode: "transform",
    initialRect,
    initialMeasurementsCache,
    initialOffset,
    paddingStart,
    paddingEnd,
    scrollMargin,
    scrollPaddingStart,
    anchorTo,
    scrollEndThreshold,
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

  let containerStyle: CSSProperties | undefined;
  if (layout === "flow") {
    const firstStart = rows[0]?.start ?? scrollMargin;
    const lastEnd = rows.at(-1)?.end ?? scrollMargin;
    containerStyle = {
      paddingTop: Math.max(0, firstStart - scrollMargin),
      paddingBottom: Math.max(0, virtualizer.getTotalSize() - (lastEnd - scrollMargin)),
    };
  } else if (!effectiveDirectDom) {
    containerStyle = { height: `${virtualizer.getTotalSize()}px` };
  }

  return (
    <div
      ref={effectiveDirectDom ? virtualizer.containerRef : undefined}
      className={cx("wb-virtual-list-inner", contentClassName)}
      style={containerStyle}
    >
      {rows.map((row, rowPosition) => {
        const item = items[row.index];
        if (item === undefined) return null;
        let rowStyle: CSSProperties | undefined;
        if (layout === "flow") {
          const prevEnd = rows[rowPosition - 1]?.end ?? row.start;
          const marginTop = row.start - prevEnd;
          rowStyle = measureItems ? { marginTop } : { marginTop, height: `${row.size}px` };
        } else if (!effectiveDirectDom) {
          rowStyle = { transform: `translateY(${row.start - scrollMargin}px)` };
        }
        const rowRef = effectiveDirectDom || measureItems ? virtualizer.measureElement : undefined;
        return (
          <div
            key={row.key}
            data-index={row.index}
            data-layout={layout}
            ref={rowRef}
            className="wb-virtual-list-row"
            style={rowStyle}
          >
            {renderRow(item, row.index)}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Windowed list built on `@tanstack/react-virtual` supporting both `absolute` and `flow` layouts,
 * parked `activeIndex`, `--wb-tree-row-height` density tracking, and optional direct DOM updates
 * strictly scoped to `layout="absolute"`.
 */
export function VirtualList<T>({
  items,
  getKey,
  renderRow,
  activeIndex,
  overscan = 10,
  estimateSize,
  measureItems = false,
  layout = "absolute",
  directDomUpdates,
  initialRect,
  initialMeasurementsCache,
  initialOffset,
  paddingStart = 0,
  paddingEnd = 0,
  scrollMargin = 0,
  scrollPaddingStart = 0,
  anchorTo,
  scrollEndThreshold,
  scrollRef,
  handleRef,
  className,
  contentClassName,
  onItemsRendered,
  ...props
}: VirtualListProps<T>) {
  const internalRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = scrollRef ?? internalRef;
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);

  // Plan 181 hard constraint: directDomUpdates is strictly disabled for flow layout.
  // A/B measurements (benchmarks/virtual-direct-dom-ab.json) showed commit/render wins on measured absolute lists.
  const effectiveDirectDom = layout === "absolute" && (directDomUpdates ?? measureItems);
  const modeKey = `${layout}:${effectiveDirectDom ? "direct" : "react"}`;

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

  return (
    <div
      {...props}
      ref={scrollerRef}
      data-wb-virtual-list=""
      data-layout={layout}
      className={cx("wb-virtual-list", className)}
    >
      <VirtualListInner
        key={modeKey}
        scrollerRef={scrollerRef}
        rowHeight={rowHeight}
        items={items}
        getKey={getKey}
        renderRow={renderRow}
        activeIndex={activeIndex}
        overscan={overscan}
        estimateSize={estimateSize}
        measureItems={measureItems}
        layout={layout}
        effectiveDirectDom={effectiveDirectDom}
        initialRect={initialRect}
        initialMeasurementsCache={initialMeasurementsCache}
        initialOffset={initialOffset}
        paddingStart={paddingStart}
        paddingEnd={paddingEnd}
        scrollMargin={scrollMargin}
        scrollPaddingStart={scrollPaddingStart}
        anchorTo={anchorTo}
        scrollEndThreshold={scrollEndThreshold}
        handleRef={handleRef}
        contentClassName={contentClassName}
        onItemsRendered={onItemsRendered}
      />
    </div>
  );
}
