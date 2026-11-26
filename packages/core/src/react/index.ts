import { useEffect, useState, useSyncExternalStore } from "react";
import {
  observeWorkbenchTheme,
  resolveColorScheme,
  type ThemeVersionSource,
  type WorkbenchColorScheme,
} from "@shaulavo/workbench-tokens";
import { attachKeyboardInset, type KeyboardInsetOptions } from "../keyboard-inset";
import { attachLongPressContextMenu, type LongPressOptions } from "../long-press";
import type { Subscribable } from "../subscribable";

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
    const node = target === undefined ? document : target;
    if (!node) return;
    return attachLongPressContextMenu(node, { delayMs, moveTolerancePx, dedupMs });
  }, [target, delayMs, moveTolerancePx, dedupMs]);
}

/** Observes light/dark scheme and theme mutations for `host` (root + nearest `[data-wb-theme-scope]`). */
export function useWorkbenchTheme(
  host: Element | null,
  themeVersion?: ThemeVersionSource,
): { readonly scheme: WorkbenchColorScheme; readonly revision: number } {
  const [state, setState] = useState<{
    readonly scheme: WorkbenchColorScheme;
    readonly revision: number;
  }>(() => ({
    scheme: resolveColorScheme(host ?? document.documentElement),
    revision: 0,
  }));

  useEffect(() => {
    const target = host ?? document.documentElement;
    const sync = (): void => {
      const nextScheme = resolveColorScheme(target);
      setState((previous) => ({ scheme: nextScheme, revision: previous.revision + 1 }));
    };
    sync();
    return observeWorkbenchTheme(target, sync, { themeVersion });
  }, [host, themeVersion]);

  return state;
}
