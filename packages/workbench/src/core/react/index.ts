import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  observeWorkbenchTheme,
  resolveColorScheme,
  type ThemeVersionSource,
  type WorkbenchColorScheme,
} from "../../tokens/index";
import { attachKeyboardInset, type KeyboardInsetOptions } from "../keyboard-inset";
import { attachLongPressContextMenu, type LongPressOptions } from "../long-press";
import type { Subscribable } from "../subscribable";

const DEFAULT_VIEWPORT_BREAKPOINT_PX = 768;

/** Subscribes a React 19 component to any referentially stable `Subscribable<T>`. */
export function useSubscribable<T>(source: Subscribable<T>): T {
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

/** Tracks mobile soft keyboard occlusion via `visualViewport` and updates `--wb-keyboard-inset`. */
export function useKeyboardInset(options?: KeyboardInsetOptions): void {
  const cssVar = options?.cssVar;
  const openThresholdPx = options?.openThresholdPx;
  const onChange = options?.onChange;

  useEffect(() => {
    return attachKeyboardInset({ cssVar, openThresholdPx, onChange });
  }, [cssVar, openThresholdPx, onChange]);
}

/** Installs iOS touch long-press `contextmenu` synthesis on `target` (defaults to `document`). */
export function useLongPressContextMenu(
  target?: HTMLElement | Document | null,
  options?: LongPressOptions,
): void {
  const delayMs = options?.delayMs;
  const moveTolerancePx = options?.moveTolerancePx;
  const dedupMs = options?.dedupMs;

  useEffect(() => {
    if (typeof document === "undefined") return;
    const node = target === undefined ? document : target;
    if (!node) return;
    return attachLongPressContextMenu(node, { delayMs, moveTolerancePx, dedupMs });
  }, [target, delayMs, moveTolerancePx, dedupMs]);
}

/**
 * Hydration-safe viewport mode hook returning `"phone"` when `(max-width: <breakpointPx>px)`
 * matches, and `"desktop"` during SSR and initial hydration before converging on the client.
 */
export function useViewportMode(breakpointPx = DEFAULT_VIEWPORT_BREAKPOINT_PX): "phone" | "desktop" {
  const query = `(max-width: ${breakpointPx}px)`;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
        return () => {};
      }
      const media = window.matchMedia(query);
      media.addEventListener("change", onStoreChange);
      return () => {
        media.removeEventListener("change", onStoreChange);
      };
    },
    [query],
  );

  const getClientSnapshot = useCallback((): "phone" | "desktop" => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return "desktop";
    }
    return window.matchMedia(query).matches ? "phone" : "desktop";
  }, [query]);

  return useSyncExternalStore(subscribe, getClientSnapshot, () => "desktop");
}

/**
 * Hydration-safe hook observing light/dark scheme and theme mutations for `host`
 * (root + nearest `[data-wb-theme-scope]`). Starts with a deterministic `{ scheme: "light", revision: 0 }`
 * snapshot shared across SSR and initial hydration, then converges to the live DOM scheme in an effect.
 */
export function useWorkbenchTheme(
  host: Element | null,
  themeVersion?: ThemeVersionSource,
): { readonly scheme: WorkbenchColorScheme; readonly revision: number } {
  const [state, setState] = useState<{
    readonly scheme: WorkbenchColorScheme;
    readonly revision: number;
  }>({
    scheme: "light",
    revision: 0,
  });

  useEffect(() => {
    if (typeof document === "undefined") return;
    const target = host ?? document.documentElement;
    if (!target) return;
    const sync = (): void => {
      const nextScheme = resolveColorScheme(target);
      setState((previous) => ({ scheme: nextScheme, revision: previous.revision + 1 }));
    };
    sync();
    return observeWorkbenchTheme(target, sync, { themeVersion });
  }, [host, themeVersion]);

  return state;
}
