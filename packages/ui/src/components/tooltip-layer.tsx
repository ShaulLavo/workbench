import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { useWorkbenchPortalContainer } from "./portal";

const TOOLTIP_DELAY_MS = 400;
const INSTANT_GRACE_MS = 300;

interface DelegatedTarget {
  readonly element: HTMLElement;
  readonly text: string;
  readonly instant: boolean;
}

function findTooltipTarget(
  raw: EventTarget | null,
  ownerScope: Element | null,
): { readonly element: HTMLElement; readonly text: string } | null {
  if (!(raw instanceof Element)) return null;
  const host = raw.closest<HTMLElement>("[data-wb-tooltip], [data-tooltip]");
  if (!host) return null;
  if (ownerScope && host.closest("[data-wb-theme-scope]") !== ownerScope) return null;
  const text = host.getAttribute("data-wb-tooltip") ?? host.getAttribute("data-tooltip") ?? "";
  if (!text.trim()) return null;
  return { element: host, text };
}

export interface TooltipLayerProps {
  readonly portalContainer?: HTMLElement | null;
}

/**
 * Mount-once delegated hover and keyboard-focus tooltip layer backed by Base UI `Tooltip`.
 * Reads `data-wb-tooltip` (and `data-tooltip`) on any element, including recycled virtualized
 * rows, with initial open delay and instant subsequent transitions.
 */
export function TooltipLayer({ portalContainer }: TooltipLayerProps) {
  const id = useId();
  const container = useWorkbenchPortalContainer(portalContainer);
  const [target, setTarget] = useState<DelegatedTarget | null>(null);
  const [shown, setShown] = useState<DelegatedTarget | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const closedAtRef = useRef(0);
  const anchorRef = useRef<HTMLElement | null>(null);
  const pressedRef = useRef<HTMLElement | null>(null);

  if (target && target !== shown) setShown(target);

  useEffect(() => {
    const ownerScope = container?.closest("[data-wb-theme-scope]") ?? null;

    function clearTimer(): void {
      if (timerRef.current === undefined) return;
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }

    function hide(): void {
      clearTimer();
      anchorRef.current = null;
      setTarget((current) => {
        if (current) closedAtRef.current = Date.now();
        return null;
      });
    }

    function open(next: { readonly element: HTMLElement; readonly text: string } | null): void {
      clearTimer();
      if (!next) {
        hide();
        return;
      }
      anchorRef.current = next.element;
      const instant = Date.now() - closedAtRef.current < INSTANT_GRACE_MS;
      if (instant) {
        setTarget({ ...next, instant: true });
        return;
      }
      timerRef.current = window.setTimeout(() => {
        setTarget({ ...next, instant: false });
      }, TOOLTIP_DELAY_MS);
    }

    function onPointerOver(event: Event): void {
      open(findTooltipTarget(event.target, ownerScope));
    }

    function onPointerMove(event: Event): void {
      const next = findTooltipTarget(event.target, ownerScope);
      const element = next?.element ?? null;
      if (element !== pressedRef.current) pressedRef.current = null;
      if (element === anchorRef.current || (element !== null && element === pressedRef.current)) return;
      open(next);
    }

    function onPointerDown(event: Event): void {
      pressedRef.current = findTooltipTarget(event.target, ownerScope)?.element ?? null;
      hide();
    }

    function onFocusIn(event: FocusEvent): void {
      const next = findTooltipTarget(event.target, ownerScope);
      if (!next?.element.matches(":focus-visible")) return;
      open(next);
    }

    function onFocusOut(event: FocusEvent): void {
      if (!(event.target instanceof Node) || !anchorRef.current?.contains(event.target)) return;
      hide();
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") hide();
    }

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointermove", onPointerMove, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      clearTimer();
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointermove", onPointerMove, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [container]);

  useEffect(() => {
    if (!target) return;
    const onScroll = (): void => {
      if (!target.element.isConnected) setTarget(null);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [target]);

  useEffect(() => {
    const element = target?.element;
    if (!element) return;
    element.setAttribute("aria-describedby", id);
    return () => element.removeAttribute("aria-describedby");
  }, [target, id]);

  return (
    <BaseTooltip.Root
      open={target !== null}
      onOpenChangeComplete={(open) => {
        if (!open) setShown(null);
      }}
    >
      <BaseTooltip.Portal container={container}>
        <BaseTooltip.Positioner
          anchor={shown?.element ?? null}
          side="bottom"
          sideOffset={6}
          className="wb-tooltip-positioner"
        >
          <BaseTooltip.Popup
            id={id}
            data-wb-tooltip-popup=""
            data-instant={shown?.instant ? "" : undefined}
            className="wb-tooltip-popup"
          >
            {shown?.text ?? ""}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

export interface TooltipProps {
  readonly content: ReactNode;
  readonly side?: "top" | "bottom" | "left" | "right";
  readonly portalContainer?: HTMLElement | null;
  readonly children: ReactNode;
}

/** Explicit declarative Base UI tooltip portaled inside the workbench theme scope. */
export function Tooltip({ content, side = "bottom", portalContainer, children }: TooltipProps) {
  const container = useWorkbenchPortalContainer(portalContainer);
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={<span className="wb-tooltip-trigger">{children}</span>} />
      <BaseTooltip.Portal container={container}>
        <BaseTooltip.Positioner side={side} sideOffset={6} className="wb-tooltip-positioner">
          <BaseTooltip.Popup className="wb-tooltip-popup" data-wb-tooltip-popup="">
            {content}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
