import { useEffect, useId, useState, type ReactNode } from "react";
import {
  fitPaneGeometry,
  type GlobalPaneGeometry,
  type LayoutAdapter,
  type Space,
} from "@shaulavo/workbench-core";
import { useSubscribable } from "@shaulavo/workbench-core/react";
import { cx } from "../utils/cx";
import { Splitter } from "./splitter";

export interface DesktopSplitGridProps {
  readonly layout: LayoutAdapter;
  readonly explorer?: ReactNode;
  readonly editor: ReactNode;
  readonly preview?: ReactNode;
  readonly terminal?: ReactNode;
  readonly className?: string;
}

function measureElementSpace(el: HTMLElement | null): Space {
  if (!el) return { width: 1200, height: 800 };
  const rect = el.getBoundingClientRect();
  return {
    width: Math.max(320, Math.round(rect.width || 1200)),
    height: Math.max(240, Math.round(rect.height || 800)),
  };
}

/**
 * Resizable desktop workbench grid managing explorer, editor, optional preview, and optional
 * terminal panes. Sets `data-wb-dragging="true"` while any splitter moves so embedded iframes
 * can disable pointer capture via CSS.
 */
export function DesktopSplitGrid({
  layout,
  explorer,
  editor,
  preview,
  terminal,
  className,
}: DesktopSplitGridProps) {
  const geometry = useSubscribable(layout.geometry);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [space, setSpace] = useState<Space>({ width: 1200, height: 800 });
  const [draggingCount, setDraggingCount] = useState(0);

  const explorerId = useId();
  const previewId = useId();
  const terminalId = useId();

  useEffect(() => {
    if (!containerEl) return;
    const sync = (): void => setSpace(measureElementSpace(containerEl));
    sync();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(sync);
    observer.observe(containerEl);
    return () => observer.disconnect();
  }, [containerEl]);

  const effectiveGeometry: GlobalPaneGeometry = {
    ...geometry,
    explorerOpen: explorer !== undefined && geometry.explorerOpen,
    previewOpen: preview !== undefined && geometry.previewOpen,
    terminalOpen: terminal !== undefined && geometry.terminalOpen,
  };
  const fitted = fitPaneGeometry(effectiveGeometry, space);

  function handleDragging(active: boolean): void {
    setDraggingCount((count) => Math.max(0, count + (active ? 1 : -1)));
  }

  function handlePreview(next: GlobalPaneGeometry): void {
    layout.setGeometry(next);
  }

  function handleCommit(next: GlobalPaneGeometry): void {
    layout.setGeometry(next);
    layout.commitGeometry();
  }

  const measureSpace = (): Space => measureElementSpace(containerEl);
  const explorerPercent = space.width > 0 ? (fitted.explorerPx / space.width) * 100 : 0;
  const previewShared = Math.max(1, space.width - fitted.explorerPx);
  const previewPercent = (fitted.previewPx / previewShared) * 100;
  const terminalPercent = space.height > 0 ? (fitted.terminalPx / space.height) * 100 : 0;

  return (
    <div
      ref={setContainerEl}
      data-wb-split-grid=""
      data-wb-dragging={draggingCount > 0 ? "true" : undefined}
      className={cx("wb-split-grid", className)}
    >
      <div className="wb-split-main">
        {explorer !== undefined ? (
          <>
            <aside
              id={explorerId}
              data-wb-pane="explorer"
              data-open={effectiveGeometry.explorerOpen ? "true" : "false"}
              className="wb-pane wb-pane-explorer"
              style={{ width: `${fitted.explorerPx}px` }}
              hidden={!effectiveGeometry.explorerOpen}
            >
              {explorer}
            </aside>
            <Splitter
              splitter="explorer"
              label="Resize explorer"
              controls={explorerId}
              geometry={geometry}
              valueNow={explorerPercent}
              measureSpace={measureSpace}
              measurePaneSize={() => fitted.explorerPx}
              onPreviewGeometry={handlePreview}
              onCommitGeometry={handleCommit}
              onDraggingChange={handleDragging}
            />
          </>
        ) : null}

        <div data-wb-pane="editor" className="wb-pane wb-pane-editor">
          {editor}
        </div>

        {preview !== undefined ? (
          <>
            <Splitter
              splitter="preview"
              label="Resize preview"
              controls={previewId}
              geometry={geometry}
              valueNow={previewPercent}
              measureSpace={measureSpace}
              measurePaneSize={() => fitted.previewPx}
              onPreviewGeometry={handlePreview}
              onCommitGeometry={handleCommit}
              onDraggingChange={handleDragging}
            />
            <section
              id={previewId}
              data-wb-pane="preview"
              data-open={effectiveGeometry.previewOpen ? "true" : "false"}
              className="wb-pane wb-pane-preview"
              style={{ width: `${fitted.previewPx}px` }}
              hidden={!effectiveGeometry.previewOpen}
            >
              {preview}
            </section>
          </>
        ) : null}
      </div>

      {terminal !== undefined ? (
        <>
          <Splitter
            splitter="terminal"
            label="Resize terminal"
            controls={terminalId}
            geometry={geometry}
            valueNow={terminalPercent}
            measureSpace={measureSpace}
            measurePaneSize={() => fitted.terminalPx}
            onPreviewGeometry={handlePreview}
            onCommitGeometry={handleCommit}
            onDraggingChange={handleDragging}
          />
          <section
            id={terminalId}
            data-wb-pane="terminal"
            data-open={effectiveGeometry.terminalOpen ? "true" : "false"}
            className="wb-pane wb-pane-terminal"
            style={{ height: `${fitted.terminalPx}px` }}
            hidden={!effectiveGeometry.terminalOpen}
          >
            {terminal}
          </section>
        </>
      ) : null}
    </div>
  );
}
