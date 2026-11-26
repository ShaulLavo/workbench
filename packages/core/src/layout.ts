import type { GlobalPaneGeometry } from "./adapters/layout";

export type SplitterId = "explorer" | "preview" | "terminal";

export interface Space {
  readonly width: number;
  readonly height: number;
}

export interface FittedGeometry {
  readonly explorerPx: number;
  readonly previewPx: number;
  readonly editorPx: number;
  readonly terminalPx: number;
}

export const GLOBAL_LAYOUT_STORAGE_KEY = "wb:layout:v1";
export const DRAG_THRESHOLD_PX = 4;

export const LAYOUT_LIMITS = {
  explorerMinPx: 160,
  explorerMaxPx: 480,
  editorMinPx: 260,
  previewMinPx: 220,
  terminalMinPx: 120,
  terminalMaxFraction: 0.72,
  codeAreaMinPx: 160,
} as const;

export const DEFAULT_PANE_GEOMETRY: GlobalPaneGeometry = {
  explorerWidthPx: 240,
  previewFraction: 0.42,
  terminalHeightPx: 220,
  explorerOpen: true,
  previewOpen: true,
  terminalOpen: true,
};

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

export function isSplitterOpen(geometry: GlobalPaneGeometry, splitter: SplitterId): boolean {
  if (splitter === "explorer") return geometry.explorerOpen;
  if (splitter === "preview") return geometry.previewOpen;
  return geometry.terminalOpen;
}

export function setSplitterOpen(
  geometry: GlobalPaneGeometry,
  splitter: SplitterId,
  open: boolean,
): GlobalPaneGeometry {
  if (splitter === "explorer") return { ...geometry, explorerOpen: open };
  if (splitter === "preview") return { ...geometry, previewOpen: open };
  return { ...geometry, terminalOpen: open };
}

/** Fits saved pane preferences into the actual container room without letting the editor collapse. */
export function fitPaneGeometry(geometry: GlobalPaneGeometry, space: Space): FittedGeometry {
  const maxExplorer = Math.max(
    0,
    Math.min(LAYOUT_LIMITS.explorerMaxPx, space.width - LAYOUT_LIMITS.editorMinPx),
  );
  const explorerPx = geometry.explorerOpen
    ? clamp(geometry.explorerWidthPx, Math.min(LAYOUT_LIMITS.explorerMinPx, maxExplorer), maxExplorer)
    : 0;

  const remainingWidth = Math.max(0, space.width - explorerPx);
  const maxPreview = Math.max(0, remainingWidth - LAYOUT_LIMITS.editorMinPx);
  const desiredPreview = Math.round(remainingWidth * geometry.previewFraction);
  const previewPx = geometry.previewOpen
    ? clamp(desiredPreview, Math.min(LAYOUT_LIMITS.previewMinPx, maxPreview), maxPreview)
    : 0;
  const editorPx = Math.max(0, remainingWidth - previewPx);

  const maxTerminal = Math.max(
    0,
    Math.min(
      Math.round(space.height * LAYOUT_LIMITS.terminalMaxFraction),
      space.height - LAYOUT_LIMITS.codeAreaMinPx,
    ),
  );
  const terminalPx = geometry.terminalOpen
    ? clamp(geometry.terminalHeightPx, Math.min(LAYOUT_LIMITS.terminalMinPx, maxTerminal), maxTerminal)
    : 0;

  return { explorerPx, previewPx, editorPx, terminalPx };
}

export interface DragGeometryInput {
  readonly startGeometry: GlobalPaneGeometry;
  readonly startPx: number;
  readonly growth: number;
  readonly space: Space;
}

/** Updates geometry during a splitter drag; dragging below half the minimum snaps the pane closed. */
export function dragPaneGeometry(splitter: SplitterId, input: DragGeometryInput): GlobalPaneGeometry {
  const raw = input.startPx + input.growth;
  if (splitter === "explorer") {
    if (raw < LAYOUT_LIMITS.explorerMinPx / 2) return { ...input.startGeometry, explorerOpen: false };
    const max = Math.min(LAYOUT_LIMITS.explorerMaxPx, input.space.width - LAYOUT_LIMITS.editorMinPx);
    return {
      ...input.startGeometry,
      explorerOpen: true,
      explorerWidthPx: clamp(Math.round(raw), LAYOUT_LIMITS.explorerMinPx, max),
    };
  }

  if (splitter === "preview") {
    if (raw < LAYOUT_LIMITS.previewMinPx / 2) return { ...input.startGeometry, previewOpen: false };
    const fitted = fitPaneGeometry(input.startGeometry, input.space);
    const shared = Math.max(1, input.space.width - fitted.explorerPx);
    const max = Math.max(LAYOUT_LIMITS.previewMinPx, shared - LAYOUT_LIMITS.editorMinPx);
    const nextPx = clamp(raw, LAYOUT_LIMITS.previewMinPx, max);
    return {
      ...input.startGeometry,
      previewOpen: true,
      previewFraction: clamp(nextPx / shared, 0.15, 0.8),
    };
  }

  if (raw < LAYOUT_LIMITS.terminalMinPx / 2) return { ...input.startGeometry, terminalOpen: false };
  const max = Math.min(
    Math.round(input.space.height * LAYOUT_LIMITS.terminalMaxFraction),
    input.space.height - LAYOUT_LIMITS.codeAreaMinPx,
  );
  return {
    ...input.startGeometry,
    terminalOpen: true,
    terminalHeightPx: clamp(Math.round(raw), LAYOUT_LIMITS.terminalMinPx, max),
  };
}

export function loadGlobalPaneGeometry(
  storage?: Pick<Storage, "getItem">,
  key: string = GLOBAL_LAYOUT_STORAGE_KEY,
): GlobalPaneGeometry {
  if (!storage) return DEFAULT_PANE_GEOMETRY;
  try {
    const raw = storage.getItem(key);
    if (!raw) return DEFAULT_PANE_GEOMETRY;
    const parsed = JSON.parse(raw) as Partial<GlobalPaneGeometry>;
    return {
      explorerWidthPx:
        typeof parsed.explorerWidthPx === "number"
          ? parsed.explorerWidthPx
          : DEFAULT_PANE_GEOMETRY.explorerWidthPx,
      previewFraction:
        typeof parsed.previewFraction === "number"
          ? parsed.previewFraction
          : DEFAULT_PANE_GEOMETRY.previewFraction,
      terminalHeightPx:
        typeof parsed.terminalHeightPx === "number"
          ? parsed.terminalHeightPx
          : DEFAULT_PANE_GEOMETRY.terminalHeightPx,
      explorerOpen:
        typeof parsed.explorerOpen === "boolean" ? parsed.explorerOpen : DEFAULT_PANE_GEOMETRY.explorerOpen,
      previewOpen:
        typeof parsed.previewOpen === "boolean" ? parsed.previewOpen : DEFAULT_PANE_GEOMETRY.previewOpen,
      terminalOpen:
        typeof parsed.terminalOpen === "boolean" ? parsed.terminalOpen : DEFAULT_PANE_GEOMETRY.terminalOpen,
    };
  } catch {
    return DEFAULT_PANE_GEOMETRY;
  }
}

export function saveGlobalPaneGeometry(
  geometry: GlobalPaneGeometry,
  storage?: Pick<Storage, "setItem">,
  key: string = GLOBAL_LAYOUT_STORAGE_KEY,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(geometry));
  } catch {
    // Storage can be blocked in private windows; geometry remains in memory for the session.
  }
}
