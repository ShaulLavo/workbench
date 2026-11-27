import {
  readTerminalTokenColors,
  resolveColorScheme,
  type RgbColor,
  type TerminalTokenColors,
  type WorkbenchColorScheme,
} from "../tokens/index";
import type {
  Terminal,
  TerminalColor,
  TerminalColorScheme,
  TerminalCursorStyle,
  TerminalTheme,
} from "ghostty-webgpu";

export interface TerminalThemeInput {
  readonly colorScheme: WorkbenchColorScheme;
  readonly background: RgbColor;
  readonly foreground: RgbColor;
  readonly cursor: RgbColor;
  readonly cursorAccent: RgbColor;
  readonly selectionBackground: RgbColor;
  readonly selectionForeground: RgbColor;
  readonly ansi: readonly RgbColor[];
  readonly backgroundOpacity?: number;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly lineHeight?: number;
  readonly cursorBlink?: boolean;
}

export interface ResolvedTerminalAppearance {
  readonly colorScheme: TerminalColorScheme;
  readonly colors: TerminalTokenColors;
  readonly backgroundOpacity: number;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly cursorBlink: boolean;
}

export interface TerminalCursorOptions {
  readonly style: TerminalCursorStyle;
  readonly blink: boolean;
}

const DEFAULT_MONO_FONT = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';
const DEFAULT_DESKTOP_FONT_SIZE = 13;
const DEFAULT_MOBILE_FONT_SIZE = 12;

function toTerminalColor(color: RgbColor): TerminalColor {
  return { r: color.r, g: color.g, b: color.b };
}

function resolveViewportFontSize(options?: {
  readonly fontSize?: number;
  readonly mobileFontSize?: number;
}): number {
  const isPhone = typeof matchMedia === "function" && matchMedia("(max-width: 768px)").matches;
  if (isPhone) {
    return options?.mobileFontSize ?? options?.fontSize ?? DEFAULT_MOBILE_FONT_SIZE;
  }
  return options?.fontSize ?? DEFAULT_DESKTOP_FONT_SIZE;
}

/** Focused terminals show a solid block cursor; unfocused terminals always show a static outline. */
export function terminalCursorOptions(focused: boolean, cursorBlink: boolean): TerminalCursorOptions {
  return {
    style: focused ? "block" : "outline",
    blink: focused && cursorBlink,
  };
}

/**
 * Projects resolved workbench colors onto a Ghostty `TerminalTheme`.
 * When `transparent` is true (`backgroundOpacity === 0`), sets `background` to `cursorAccent`
 * so the host pane well shows through behind the canvas while cursor contrast stays legible.
 */
export function buildGhosttyTheme(
  colors: TerminalTokenColors | TerminalThemeInput,
  currentTheme: TerminalTheme,
  options?: { readonly transparent?: boolean },
): TerminalTheme {
  const palette = currentTheme.palette.slice();
  const limit = Math.min(colors.ansi.length, palette.length);
  for (let i = 0; i < limit; i += 1) {
    const ansiColor = colors.ansi[i];
    if (ansiColor) palette[i] = toTerminalColor(ansiColor);
  }
  const transparent = options?.transparent ?? false;
  return {
    ...currentTheme,
    background: toTerminalColor(transparent ? colors.cursorAccent : colors.background),
    foreground: toTerminalColor(colors.foreground),
    cursor: toTerminalColor(colors.cursor),
    selectionBackground: toTerminalColor(colors.selectionBackground),
    selectionForeground: toTerminalColor(colors.selectionForeground),
    palette,
  };
}

/** Reads CSS `--wb-term-*`, `--wb-font-mono`, and responsive font size from `host`. */
export function readCssTerminalAppearance(
  host: Element,
  options?: {
    readonly fontSize?: number;
    readonly mobileFontSize?: number;
    readonly backgroundOpacity?: number;
    readonly cursorBlink?: boolean;
  },
): ResolvedTerminalAppearance {
  const colorScheme = resolveColorScheme(host);
  const colors = readTerminalTokenColors(host);
  const style = getComputedStyle(host);
  const rawMono = style.getPropertyValue("--wb-font-mono").trim();
  const fontSize = resolveViewportFontSize({
    fontSize: options?.fontSize,
    mobileFontSize: options?.mobileFontSize,
  });

  return {
    colorScheme,
    colors,
    backgroundOpacity: options?.backgroundOpacity ?? 1,
    fontFamily: rawMono || DEFAULT_MONO_FONT,
    fontSize,
    lineHeight: 1.2,
    cursorBlink: options?.cursorBlink ?? false,
  };
}

/**
 * Resolves either a consumer-supplied typed palette (`theme`) or live CSS tokens from `host`.
 *
 * Font-size precedence:
 * 1. Explicit reactive `fontSizeOverride` (`fontSize` prop when a `Subscribable<number>`).
 * 2. `theme.fontSize` when `theme` is supplied and sets a numeric `fontSize`.
 * 3. Explicit numeric viewport props: `mobileFontSize ?? fontSize` on phone, `fontSize` on desktop.
 * 4. Built-in defaults: `12` on phone, `13` on desktop.
 */
export function resolveTerminalAppearance(
  host: Element,
  options?: {
    readonly theme?: TerminalThemeInput;
    readonly fontSizeOverride?: number;
    readonly fontSize?: number;
    readonly mobileFontSize?: number;
    readonly backgroundOpacity?: number;
    readonly cursorBlink?: boolean;
  },
): ResolvedTerminalAppearance {
  const css = readCssTerminalAppearance(host, {
    fontSize: options?.fontSize,
    mobileFontSize: options?.mobileFontSize,
    backgroundOpacity: options?.backgroundOpacity,
    cursorBlink: options?.cursorBlink,
  });
  const theme = options?.theme;
  if (!theme) {
    return options?.fontSizeOverride !== undefined ? { ...css, fontSize: options.fontSizeOverride } : css;
  }
  return {
    colorScheme: theme.colorScheme,
    colors: {
      background: theme.background,
      foreground: theme.foreground,
      cursor: theme.cursor,
      cursorAccent: theme.cursorAccent,
      selectionBackground: theme.selectionBackground,
      selectionForeground: theme.selectionForeground,
      ansi: theme.ansi,
    },
    backgroundOpacity: theme.backgroundOpacity ?? options?.backgroundOpacity ?? 0,
    fontFamily: theme.fontFamily ?? css.fontFamily,
    fontSize: options?.fontSizeOverride ?? theme.fontSize ?? css.fontSize,
    lineHeight: theme.lineHeight ?? css.lineHeight,
    cursorBlink: theme.cursorBlink ?? options?.cursorBlink ?? false,
  };
}

/** Applies full appearance (scheme, theme, opacity, font, cursor) to a live Ghostty terminal. */
export function applyTerminalAppearanceToInstance(
  terminal: Terminal,
  appearance: ResolvedTerminalAppearance,
  focused: boolean,
): void {
  const transparent = appearance.backgroundOpacity === 0;
  const theme = buildGhosttyTheme(appearance.colors, terminal.appearance.theme, { transparent });
  const cursor = terminalCursorOptions(focused, appearance.cursorBlink);
  terminal.setAppearance({
    colorScheme: appearance.colorScheme,
    backgroundOpacity: appearance.backgroundOpacity,
    theme,
    font: {
      family: appearance.fontFamily,
      size: appearance.fontSize,
      lineHeight: appearance.lineHeight,
      weight: 400,
      boldWeight: 700,
    },
    cursor,
  });
}
