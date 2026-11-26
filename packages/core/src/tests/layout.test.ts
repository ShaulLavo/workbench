import { describe, expect, test } from "vitest";
import {
  DEFAULT_PANE_GEOMETRY,
  dragPaneGeometry,
  fitPaneGeometry,
  loadGlobalPaneGeometry,
  saveGlobalPaneGeometry,
} from "../layout";

describe("layout", () => {
  test("fits saved pane sizes while preserving editor minimum width", () => {
    const fitted = fitPaneGeometry(DEFAULT_PANE_GEOMETRY, { width: 1200, height: 800 });
    expect(fitted.explorerPx).toBe(240);
    expect(fitted.editorPx).toBeGreaterThanOrEqual(260);
    expect(fitted.explorerPx + fitted.editorPx + fitted.previewPx).toBe(1200);
    expect(fitted.terminalPx).toBe(220);
  });

  test("dragging below half minimum snaps pane closed", () => {
    const collapsed = dragPaneGeometry("explorer", {
      startGeometry: DEFAULT_PANE_GEOMETRY,
      startPx: 240,
      growth: -200,
      space: { width: 1200, height: 800 },
    });
    expect(collapsed.explorerOpen).toBe(false);
  });

  test("persists and reloads global pane geometry safely", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => {
        map.set(k, v);
      },
    };
    const next = { ...DEFAULT_PANE_GEOMETRY, explorerWidthPx: 312, terminalOpen: false };
    saveGlobalPaneGeometry(next, storage);
    expect(loadGlobalPaneGeometry(storage)).toEqual(next);
  });
});
