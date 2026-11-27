import type { EditorScrollPosition } from "@singapore-editor/core/editor";
import type { EditorViewSnapshot } from "@singapore-editor/core/extensions";

/** Extracts `{ left, top }` scroll offsets from a Singapore `EditorViewSnapshot`. */
export function scrollPositionFromSnapshot(snapshot: EditorViewSnapshot | null): EditorScrollPosition | null {
  if (!snapshot) return null;
  return {
    left: snapshot.viewport.scrollLeft,
    top: snapshot.viewport.scrollTop,
  };
}

/** Keeps the last row anchored to the viewport bottom on restore, clamping overscroll. */
export function capOverscrollTop(top: number, snapshot: EditorViewSnapshot | null): number {
  if (!snapshot) return top;
  const { totalHeight, viewport } = snapshot;
  if (totalHeight <= 0 || viewport.clientHeight <= 0) return top;
  return Math.min(top, Math.max(0, totalHeight - viewport.clientHeight));
}

/** Clamps a restored scroll offset against known content and viewport heights. */
export function clampRestoredScroll(
  scroll: EditorScrollPosition | undefined,
  contentHeight: number,
  viewportHeight: number,
): EditorScrollPosition | undefined {
  if (!scroll || scroll.top === undefined) return scroll;
  if (contentHeight <= 0 || viewportHeight <= 0) return scroll;
  const maxTop = Math.max(0, contentHeight - viewportHeight);
  const top = Math.min(scroll.top, maxTop);
  if (top === scroll.top) return scroll;
  return { ...scroll, top };
}
