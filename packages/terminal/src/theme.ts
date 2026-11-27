import {
  readTerminalTokenColors,
  resolveColorScheme,
  type RgbColor,
  type TerminalTokenColors,
  type WorkbenchColorScheme,
} from "@shaulavo/workbench-tokens";
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
    readonly desktopFontSize?: number;
    readonly mobileFontSize?: number;
    readonly backgroundOpacity?: number;
    readonly cursorBlink?: boolean;
  },
): ResolvedTerminalAppearance {
  const colorScheme = resolveColorScheme(host);
  const colors = readTerminalTokenColors(host);
  const style = getComputedStyle(host);
  const rawMono = style.getPropertyValue("--wb-font-mono").trim();
  const isPhone = typeof matchMedia === "function" && matchMedia("(max-width: 768px)").matches;
  const fontSize = isPhone
    ? (options?.mobileFontSize ?? DEFAULT_MOBILE_FONT_SIZE)
    : (options?.desktopFontSize ?? DEFAULT_DESKTOP_FONT_SIZE);

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

/** Resolves either a consumer-supplied typed palette override or live CSS tokens from `host`. */
export function resolveTerminalAppearance(
  host: Element,
  options?: {
    readonly override?: TerminalThemeInput;
    readonly fontSizeOverride?: number;
    readonly desktopFontSize?: number;
    readonly mobileFontSize?: number;
    readonly backgroundOpacity?: number;
    readonly cursorBlink?: boolean;
  },
): ResolvedTerminalAppearance {
  const css = readCssTerminalAppearance(host, options);
  const override = options?.override;
  if (!override) {
    return options?.fontSizeOverride !== undefined ? { ...css, fontSize: options.fontSizeOverride } : css;
  }
  return {
    colorScheme: override.colorScheme,
    colors: {
      background: override.background,
      foreground: override.foreground,
      cursor: override.cursor,
      cursorAccent: override.cursorAccent,
      selectionBackground: override.selectionBackground,
      selectionForeground: override.selectionForeground,
      ansi: override.ansi,
    },
    backgroundOpacity: override.backgroundOpacity ?? options?.backgroundOpacity ?? 0,
    fontFamily: override.fontFamily ?? css.fontFamily,
    fontSize: options?.fontSizeOverride ?? override.fontSize ?? css.fontSize,
    lineHeight: override.lineHeight ?? css.lineHeight,
    cursorBlink: override.cursorBlink ?? options?.cursorBlink ?? false,
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
