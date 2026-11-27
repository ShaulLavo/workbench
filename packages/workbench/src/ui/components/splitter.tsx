import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import {
  DRAG_THRESHOLD_PX,
  dragPaneGeometry,
  isSplitterOpen,
  setSplitterOpen,
  type GlobalPaneGeometry,
  type Space,
  type SplitterId,
} from "../../core/index";
import { cx } from "../utils/cx";

const GROWTH: Readonly<Record<SplitterId, 1 | -1>> = {
  explorer: 1,
  preview: -1,
  terminal: -1,
};

const KEY_STEP_PX = 24;
const KEY_BIG_STEP_PX = 96;

interface DragGesture {
  readonly pointerId: number;
  readonly startCoord: number;
  latestCoord: number;
  dragged: boolean;
  readonly startGeometry: GlobalPaneGeometry;
  currentGeometry: GlobalPaneGeometry;
  readonly startPx: number;
  readonly space: Space;
}

interface DragState {
  gesture: DragGesture | undefined;
  frameId: number;
}

export interface SplitterProps {
  readonly splitter: SplitterId;
  readonly label: string;
  readonly controls: string;
  readonly geometry: GlobalPaneGeometry;
  readonly valueNow: number;
  readonly measureSpace: () => Space;
  readonly measurePaneSize: () => number;
  readonly onPreviewGeometry: (next: GlobalPaneGeometry) => void;
  readonly onCommitGeometry: (next: GlobalPaneGeometry) => void;
  readonly onDraggingChange?: (dragging: boolean) => void;
  readonly className?: string;
}

function keyDeltaPx(splitter: SplitterId, event: KeyboardEvent): number | "min" | "max" | "toggle" | null {
  if (event.key === "Enter" || event.key === " ") return "toggle";
  if (event.key === "Home") return "min";
  if (event.key === "End") return "max";
  const step = event.shiftKey ? KEY_BIG_STEP_PX : KEY_STEP_PX;
  const vertical = splitter !== "terminal";
  if (vertical) {
    if (event.key === "ArrowRight") return GROWTH[splitter] * step;
    if (event.key === "ArrowLeft") return -GROWTH[splitter] * step;
    return null;
  }
  if (event.key === "ArrowDown") return GROWTH[splitter] * step;
  if (event.key === "ArrowUp") return -GROWTH[splitter] * step;
  return null;
}

/**
 * Accessible WAI-ARIA resize handle supporting pointer drag (RAF-throttled, pointer capture),
 * double-click collapse/reopen, and keyboard arrows, Shift+arrows, Home, End, and Enter.
 */
export function Splitter({
  splitter,
  label,
  controls,
  geometry,
  valueNow,
  measureSpace,
  measurePaneSize,
  onPreviewGeometry,
  onCommitGeometry,
  onDraggingChange,
  className,
}: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const stateRef = useRef<DragState>({ gesture: undefined, frameId: 0 });

  const vertical = splitter !== "terminal";
  const closed = !isSplitterOpen(geometry, splitter);

  useEffect(() => {
    const state = stateRef.current;
    return () => {
      if (state.frameId) cancelAnimationFrame(state.frameId);
      state.frameId = 0;
      state.gesture = undefined;
    };
  }, []);

  function readCoord(event: PointerEvent<HTMLDivElement>): number {
    return vertical ? event.clientX : event.clientY;
  }

  function flushFrame(): void {
    const state = stateRef.current;
    state.frameId = 0;
    const gesture = state.gesture;
    if (!gesture) return;
    const growth = GROWTH[splitter] * (gesture.latestCoord - gesture.startCoord);
    if (!gesture.dragged && Math.abs(growth) < DRAG_THRESHOLD_PX) return;
    gesture.dragged = true;
    const next = dragPaneGeometry(splitter, {
      startGeometry: gesture.startGeometry,
      startPx: gesture.startPx,
      growth,
      space: gesture.space,
    });
    gesture.currentGeometry = next;
    onPreviewGeometry(next);
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    const state = stateRef.current;
    if (event.button !== 0 || state.gesture) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startCoord = readCoord(event);
    const startPx = isSplitterOpen(geometry, splitter) ? measurePaneSize() : 0;
    state.gesture = {
      pointerId: event.pointerId,
      startCoord,
      latestCoord: startCoord,
      dragged: false,
      startGeometry: geometry,
      currentGeometry: geometry,
      startPx,
      space: measureSpace(),
    };
    setDragging(true);
    onDraggingChange?.(true);
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    const state = stateRef.current;
    const gesture = state.gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    gesture.latestCoord = readCoord(event);
    if (!state.frameId) state.frameId = requestAnimationFrame(flushFrame);
  }

  function endDrag(): void {
    const state = stateRef.current;
    const gesture = state.gesture;
    if (!gesture) return;
    if (state.frameId) cancelAnimationFrame(state.frameId);
    flushFrame();
    const didDrag = gesture.dragged;
    const finalGeometry = gesture.currentGeometry;
    state.gesture = undefined;
    setDragging(false);
    onDraggingChange?.(false);
    if (didDrag) onCommitGeometry(finalGeometry);
  }

  function handleDoubleClick(): void {
    const next = setSplitterOpen(geometry, splitter, !isSplitterOpen(geometry, splitter));
    onCommitGeometry(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const action = keyDeltaPx(splitter, event);
    if (action === null) return;
    event.preventDefault();
    if (action === "toggle") {
      onCommitGeometry(setSplitterOpen(geometry, splitter, !isSplitterOpen(geometry, splitter)));
      return;
    }
    const space = measureSpace();
    const currentPx = isSplitterOpen(geometry, splitter) ? measurePaneSize() : 0;
    const growth =
      action === "min"
        ? -currentPx - 10_000
        : action === "max"
          ? Math.max(space.width, space.height)
          : action;
    const next = dragPaneGeometry(splitter, {
      startGeometry: geometry,
      startPx: currentPx,
      growth,
      space,
    });
    onCommitGeometry(next);
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-controls={controls}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(Math.max(0, Math.min(100, valueNow)))}
      data-wb-splitter={splitter}
      data-orientation={vertical ? "vertical" : "horizontal"}
      data-dragging={dragging ? "true" : undefined}
      data-closed={closed ? "true" : undefined}
      className={cx("wb-splitter", className)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    />
  );
}
