import type { Ref } from "react";
import { FileTypeIcon, StrokeIcon } from "@shaulavo/workbench-icons/react";
import type { StickyAncestorsState } from "../model";

export interface StickyAncestorsOverlayProps {
  readonly rows: StickyAncestorsState["rows"];
  readonly initialPushUpPx?: number;
  readonly overlayRef?: Ref<HTMLDivElement>;
  readonly iconPreset: "rich" | "stroke";
  readonly onSelectAncestor: (dirPath: string) => void;
}

/**
 * Renders pinned ancestor folder rows at the top of a scrolled tree.
 * Receives an `overlayRef` so smooth push-up offsets update directly in the DOM during scrolling
 * without triggering React re-renders on every scroll pixel.
 */
export function StickyAncestorsOverlay({
  rows,
  initialPushUpPx = 0,
  overlayRef,
  iconPreset,
  onSelectAncestor,
}: StickyAncestorsOverlayProps) {
  if (rows.length === 0) return null;

  return (
    <div
      ref={overlayRef}
      className="wb-tree-sticky"
      data-wb-tree-sticky=""
      style={
        initialPushUpPx > 0
          ? {
              transform: `translateY(${-initialPushUpPx}px)`,
            }
          : undefined
      }
    >
      {rows.map((row) => (
        <button
          key={row.path}
          type="button"
          className="wb-tree-row wb-tree-sticky-row"
          data-wb-sticky-path={row.path}
          data-testid={`wb-tree-sticky-${row.path}`}
          style={{ paddingLeft: `calc(${row.depth} * var(--wb-tree-indent) + 0.375rem)` }}
          onClick={() => onSelectAncestor(row.path)}
        >
          <span className="wb-tree-chevron" data-expanded="true" aria-hidden="true">
            <StrokeIcon name="chevron" />
          </span>
          <FileTypeIcon entry={{ name: row.name, type: "directory" }} open preset={iconPreset} sprite />
          <span className="wb-tree-name">
            <span className="wb-tree-stem">{row.name}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
