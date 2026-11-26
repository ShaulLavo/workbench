export interface KeyboardInsetOptions {
  /** Custom property to update on `document.documentElement`. Defaults to `"--wb-keyboard-inset"`. */
  readonly cssVar?: string;
  /** Threshold in CSS pixels above which the soft keyboard is treated as open. Defaults to `80`. */
  readonly openThresholdPx?: number;
  readonly onChange?: (insetPx: number, open: boolean) => void;
}

/**
 * Tracks iOS Safari / mobile browser soft keyboard occlusion via `visualViewport`, updates
 * `--wb-keyboard-inset`, and resets layout scroll jump (`window.scrollTo(0, 0)`) when the
 * keyboard lifts the viewport.
 */
export function attachKeyboardInset(options?: KeyboardInsetOptions): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  const cssVar = options?.cssVar ?? "--wb-keyboard-inset";
  const threshold = options?.openThresholdPx ?? 80;
  const root = document.documentElement;
  let lastInset = -1;

  const update = (): void => {
    const raw = window.innerHeight - viewport.height - viewport.offsetTop;
    const inset = raw > 0 ? Math.round(raw) : 0;
    if (inset !== lastInset) {
      lastInset = inset;
      root.style.setProperty(cssVar, `${inset}px`);
      options?.onChange?.(inset, inset >= threshold);
    }
    if (inset >= threshold && (window.scrollX !== 0 || window.scrollY !== 0)) {
      window.scrollTo(0, 0);
    }
  };

  update();
  viewport.addEventListener("resize", update);
  viewport.addEventListener("scroll", update);
  window.addEventListener("orientationchange", update);

  return () => {
    viewport.removeEventListener("resize", update);
    viewport.removeEventListener("scroll", update);
    window.removeEventListener("orientationchange", update);
    root.style.removeProperty(cssVar);
  };
}
