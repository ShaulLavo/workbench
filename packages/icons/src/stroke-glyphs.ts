export interface StrokeGlyph {
  readonly paths: readonly string[];
}

const FILE_SHEET = "M6 3.5h7.5l5 5V19a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 19V5A1.5 1.5 0 0 1 6 3.5z";

/**
 * Minimal 24x24 single-stroke UI chrome icons (MIT) for lightweight workbench controls
 * such as chevrons, search, close buttons, pane tabs, and status indicators.
 */
export const STROKE_ICON_GLYPHS = {
  chevron: { paths: ["m9 6 6 6-6 6"] },
  folder: {
    paths: [
      "M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2l1.8 2h8A1.5 1.5 0 0 1 20.5 8.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z",
    ],
  },
  "folder-open": {
    paths: [
      "M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2l1.8 2h8A1.5 1.5 0 0 1 20.5 8.5V10H6.3a1.5 1.5 0 0 0-1.45 1.1L3.5 16.5z",
      "M3.5 17.5 5 11.1A1.5 1.5 0 0 1 6.45 10H20.5l-1.35 7.5A1.5 1.5 0 0 1 17.7 19H5a1.5 1.5 0 0 1-1.5-1.5z",
    ],
  },
  file: { paths: [FILE_SHEET, "M13.5 3.5v5h5"] },
  search: { paths: ["M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z", "m20 20-4.2-4.2"] },
  close: { paths: ["M6.5 6.5l11 11M17.5 6.5l-11 11"] },
  plus: { paths: ["M12 5v14M5 12h14"] },
  more: { paths: ["M6 12h.01M12 12h.01M18 12h.01"] },
  terminal: {
    paths: [
      "M4.5 6A1.5 1.5 0 0 1 6 4.5h12A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18z",
      "m8 9.5 3 2.5-3 2.5M12.5 15H16",
    ],
  },
  preview: {
    paths: [
      "M4.5 5.5h15A1.5 1.5 0 0 1 21 7v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17V7a1.5 1.5 0 0 1 1.5-1.5z",
      "M3 9h18",
    ],
  },
  split: {
    paths: [
      "M4.5 5.5h15A1.5 1.5 0 0 1 21 7v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17V7a1.5 1.5 0 0 1 1.5-1.5z",
      "M12 5.5v13",
    ],
  },
  check: { paths: ["m5.5 12.5 4.2 4.2L18.5 7.5"] },
  warning: {
    paths: ["M12 4.2 20.4 19a1 1 0 0 1-.87 1.5H4.47a1 1 0 0 1-.87-1.5z", "M12 10v4.5M12 17.2h.01"],
  },
  error: {
    paths: ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", "m9 9 6 6M15 9l-6 6"],
  },
  info: {
    paths: ["M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z", "M12 11v5.5M12 8.2h.01"],
  },
  refresh: {
    paths: ["M19 12a7 7 0 1 1-2.05-4.95L19 9", "M19 4.5V9h-4.5"],
  },
} as const satisfies Record<string, StrokeGlyph>;

export type StrokeIconName = keyof typeof STROKE_ICON_GLYPHS;
