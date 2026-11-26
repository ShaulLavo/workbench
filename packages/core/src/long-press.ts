export interface LongPressOptions {
  /** Hold duration before dispatching synthetic `contextmenu`. Defaults to 550ms. */
  readonly delayMs?: number;
  /** Movement tolerance in CSS pixels before cancelling. Defaults to 10px. */
  readonly moveTolerancePx?: number;
  /** Window in ms during which a following native `contextmenu` is suppressed to prevent duplicates. Defaults to 700ms. */
  readonly dedupMs?: number;
}

function isSelectableTextPoint(target: EventTarget | null, x: number, y: number): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const userSelect = getComputedStyle(target).userSelect;
  if (userSelect === "none") return false;
  const doc = target.ownerDocument as Document & {
    caretRangeFromPoint?: (cx: number, cy: number) => Range | null;
  };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range?.startContainer.nodeType === Node.TEXT_NODE;
}

/**
 * Synthesizes `contextmenu` on touch long-press for iOS Safari where native long-press does not
 * fire `contextmenu` on non-link chrome. Skips selectable text so native iOS selection works.
 */
export function attachLongPressContextMenu(
  root: HTMLElement | Document,
  options?: LongPressOptions,
): () => void {
  const delayMs = options?.delayMs ?? 550;
  const tolerance = options?.moveTolerancePx ?? 10;
  const dedupMs = options?.dedupMs ?? 700;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let activePointerId: number | undefined;
  let startX = 0;
  let startY = 0;
  let suppressClickUntil = 0;
  let suppressNativeContextUntil = 0;

  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    activePointerId = undefined;
  };

  const onPointerDown = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (pointer.pointerType !== "touch" || !pointer.isPrimary) return;
    if (isSelectableTextPoint(pointer.target, pointer.clientX, pointer.clientY)) return;
    cancel();
    activePointerId = pointer.pointerId;
    startX = pointer.clientX;
    startY = pointer.clientY;
    const target = pointer.target;
    timer = setTimeout(() => {
      timer = undefined;
      if (!(target instanceof Element)) return;
      const now = Date.now();
      suppressClickUntil = now + dedupMs;
      suppressNativeContextUntil = now + dedupMs;
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: startX,
          clientY: startY,
          screenX: pointer.screenX,
          screenY: pointer.screenY,
        }),
      );
    }, delayMs);
  };

  const onPointerMove = (event: Event): void => {
    const pointer = event as PointerEvent;
    if (pointer.pointerId !== activePointerId) return;
    if (Math.hypot(pointer.clientX - startX, pointer.clientY - startY) > tolerance) cancel();
  };

  const onClickCapture = (event: Event): void => {
    if (Date.now() <= suppressClickUntil) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickUntil = 0;
    }
  };

  const onContextMenuCapture = (event: Event): void => {
    if (event.isTrusted && Date.now() <= suppressNativeContextUntil) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  root.addEventListener("pointerdown", onPointerDown, { passive: true });
  root.addEventListener("pointermove", onPointerMove, { passive: true });
  root.addEventListener("pointerup", cancel, { passive: true });
  root.addEventListener("pointercancel", cancel, { passive: true });
  root.addEventListener("scroll", cancel, { capture: true, passive: true });
  root.addEventListener("click", onClickCapture, true);
  root.addEventListener("contextmenu", onContextMenuCapture, true);

  return () => {
    cancel();
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerup", cancel);
    root.removeEventListener("pointercancel", cancel);
    root.removeEventListener("scroll", cancel, true);
    root.removeEventListener("click", onClickCapture, true);
    root.removeEventListener("contextmenu", onContextMenuCapture, true);
  };
}
