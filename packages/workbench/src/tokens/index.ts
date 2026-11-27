export type WorkbenchColorScheme = "light" | "dark";

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface TerminalTokenColors {
  readonly background: RgbColor;
  readonly foreground: RgbColor;
  readonly cursor: RgbColor;
  readonly cursorAccent: RgbColor;
  readonly selectionBackground: RgbColor;
  readonly selectionForeground: RgbColor;
  readonly ansi: readonly RgbColor[];
}

export interface ThemeVersionSource {
  subscribe(listener: () => void): () => void;
}

export interface ThemeObserverOptions {
  /** Optional signal for apps that rewrite a `<style>` tag without mutating DOM attributes. */
  readonly themeVersion?: ThemeVersionSource;
}

const FALLBACK_BLACK: RgbColor = { r: 0, g: 0, b: 0 };
const HEX_SHORT_RE = /^#([0-9a-f]{3})$/i;
const HEX_LONG_RE = /^#([0-9a-f]{6})$/i;
const RGB_FUNC_RE = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i;
const SRGB_FUNC_RE = /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/i;

const SURFACE_TOKENS = {
  background: "--wb-term-bg",
  foreground: "--wb-term-fg",
  cursor: "--wb-term-cursor",
  cursorAccent: "--wb-term-cursor-accent",
  selectionBackground: "--wb-term-selection",
  selectionForeground: "--wb-term-selection-fg",
} as const;

const ANSI_TOKENS: readonly string[] = Array.from({ length: 16 }, (_, index) => `--wb-term-ansi-${index}`);

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Parses browser-computed `rgb(...)`, `color(srgb ...)`, or `#hex` color strings into 8-bit RGB. */
export function parseCssColor(value: string): RgbColor | undefined {
  const trimmed = value.trim();
  const rgbMatch = RGB_FUNC_RE.exec(trimmed);
  if (rgbMatch) {
    return {
      r: clampByte(Number(rgbMatch[1])),
      g: clampByte(Number(rgbMatch[2])),
      b: clampByte(Number(rgbMatch[3])),
    };
  }
  const srgbMatch = SRGB_FUNC_RE.exec(trimmed);
  if (srgbMatch) {
    return {
      r: clampByte(Number(srgbMatch[1]) * 255),
      g: clampByte(Number(srgbMatch[2]) * 255),
      b: clampByte(Number(srgbMatch[3]) * 255),
    };
  }
  const hexLong = HEX_LONG_RE.exec(trimmed);
  if (hexLong?.[1]) {
    const raw = hexLong[1];
    return {
      r: parseInt(raw.slice(0, 2), 16),
      g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16),
    };
  }
  const hexShort = HEX_SHORT_RE.exec(trimmed);
  if (hexShort?.[1]) {
    const raw = hexShort[1];
    return {
      r: parseInt(raw.charAt(0) + raw.charAt(0), 16),
      g: parseInt(raw.charAt(1) + raw.charAt(1), 16),
      b: parseInt(raw.charAt(2) + raw.charAt(2), 16),
    };
  }
  return undefined;
}

/** Resolves the effective light/dark scheme for `element`, respecting scoped `color-scheme` and `data-theme`. */
export function resolveColorScheme(element: Element = document.documentElement): WorkbenchColorScheme {
  const scope = element.closest("[data-theme], [data-wb-theme-scope]") ?? element;
  const attr = scope.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  if (scope.classList.contains("dark")) return "dark";

  const declared = getComputedStyle(element).colorScheme.split(/\s+/);
  const explicit = declared.filter((part) => part === "light" || part === "dark");
  if (explicit.length === 1) return explicit[0] as WorkbenchColorScheme;

  if (typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

/** Resolves a single CSS custom property (including `light-dark(...)`) on `host` via a temporary probe node. */
export function resolveTokenRgb(host: Element, tokenName: string): RgbColor {
  const probe = host.ownerDocument.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.color = `var(${tokenName})`;
  host.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return parseCssColor(computed) ?? FALLBACK_BLACK;
}

/** Resolves all terminal surface and 16 ANSI color tokens inside `host` using a single probe node. */
export function readTerminalTokenColors(host: Element): TerminalTokenColors {
  const probe = host.ownerDocument.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  host.appendChild(probe);
  const style = getComputedStyle(probe);
  const read = (tokenName: string): RgbColor => {
    probe.style.color = `var(${tokenName})`;
    return parseCssColor(style.color) ?? FALLBACK_BLACK;
  };
  const colors: TerminalTokenColors = {
    background: read(SURFACE_TOKENS.background),
    foreground: read(SURFACE_TOKENS.foreground),
    cursor: read(SURFACE_TOKENS.cursor),
    cursorAccent: read(SURFACE_TOKENS.cursorAccent),
    selectionBackground: read(SURFACE_TOKENS.selectionBackground),
    selectionForeground: read(SURFACE_TOKENS.selectionForeground),
    ansi: ANSI_TOKENS.map(read),
  };
  probe.remove();
  return colors;
}

const OBSERVED_ATTRS = [
  "data-theme",
  "data-wb-theme",
  "data-wb-density",
  "data-density",
  "data-wb-shell",
  "data-shell",
  "class",
  "style",
];

/**
 * Observes theme, density, and color-scheme mutations on both `document.documentElement` and
 * the nearest `[data-wb-theme-scope]` ancestor of `host`, plus system `prefers-color-scheme`
 * and an optional `themeVersion` signal.
 */
export function observeWorkbenchTheme(
  host: Element,
  onChange: () => void,
  options?: ThemeObserverOptions,
): () => void {
  const doc = host.ownerDocument;
  const root = doc.documentElement;
  const scope = host.closest("[data-wb-theme-scope]");
  const observer = new MutationObserver(() => onChange());
  observer.observe(root, { attributes: true, attributeFilter: OBSERVED_ATTRS });
  if (scope && scope !== root) {
    observer.observe(scope, { attributes: true, attributeFilter: OBSERVED_ATTRS });
  }

  const media = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
  const onMediaChange = () => onChange();
  media?.addEventListener("change", onMediaChange);

  const unsubscribeVersion = options?.themeVersion?.subscribe(onChange);

  return () => {
    observer.disconnect();
    media?.removeEventListener("change", onMediaChange);
    unsubscribeVersion?.();
  };
}
