import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { observeWorkbenchTheme, type ThemeVersionSource } from "@shaulavo/workbench-tokens";
import { cx } from "@shaulavo/workbench-ui";
import type { Editor } from "@singapore-editor/core/editor";
import type { EditorTheme } from "@singapore-editor/core/rendering";
import {
  createDiffEditorOptions,
  createDiffPlugin,
  createDiffRegionStore,
  createTextDiff,
  joinRenderLines,
  type DiffFile,
  type DiffGutterSide,
  type DiffRegionStore,
} from "@singapore-editor/diff";
import { useEditor } from "@singapore-editor/react";
import { languageIdForPath } from "../utils/language";
import { buildWorkbenchEditorTheme } from "../utils/theme";

export type DiffViewMode = "split" | "stacked";

export interface DiffEditorViewProps {
  /** Pre-built `DiffFile` (e.g. from `parseGitPatch`), or omit and supply `originalText` + `modifiedText`. */
  readonly file?: DiffFile | null;
  readonly path?: string;
  readonly originalText?: string;
  readonly modifiedText?: string;
  readonly mode?: DiffViewMode;
  readonly regions?: DiffRegionStore;
  readonly themeVersion?: ThemeVersionSource;
  readonly fontSize?: number;
  readonly lineHeight?: number;
  readonly emptyMessage?: string;
  readonly className?: string;
}

interface DiffSidePaneProps {
  readonly file: DiffFile;
  readonly side: DiffGutterSide;
  readonly regions: DiffRegionStore;
  readonly theme: EditorTheme;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly onEditorRef?: (side: DiffGutterSide, editor: Editor | null) => void;
  readonly onScrollTop?: (side: DiffGutterSide, top: number) => void;
}

function DiffSidePane({
  file,
  side,
  regions,
  theme,
  fontSize,
  lineHeight,
  onEditorRef,
  onScrollTop,
}: DiffSidePaneProps) {
  const plugin = useMemo(
    () =>
      createDiffPlugin({
        mode: "document",
        regions,
        side,
        syntaxHighlight: false,
      }),
    [regions, side],
  );

  const [renderText, setRenderText] = useState("");
  const [rowRevision, setRowRevision] = useState(0);

  useLayoutEffect(() => {
    const syncRows = (): void => {
      const rows = side === "stacked" ? plugin.getStackedRows() : plugin.getRows();
      setRenderText(joinRenderLines(rows));
      setRowRevision((rev) => rev + 1);
    };
    plugin.setFile(file);
    syncRows();
    const sub = plugin.onDidChangeRows(syncRows);
    return () => {
      sub.dispose();
    };
  }, [file, plugin, side]);

  const diffOptions = useMemo(() => createDiffEditorOptions(), []);
  const plugins = useMemo(() => [plugin], [plugin]);
  const documentSpec = useMemo(
    () => ({
      documentId: `diff:${file.path}:${side}:${rowRevision}`,
      text: renderText,
      languageId: null,
    }),
    [file.path, renderText, rowRevision, side],
  );

  const emitEditorRef = useEffectEvent((targetSide: DiffGutterSide, editor: Editor | null) => {
    onEditorRef?.(targetSide, editor);
  });
  const emitScrollTop = useEffectEvent((targetSide: DiffGutterSide, top: number) => {
    onScrollTop?.(targetSide, top);
  });

  const controller = useEditor({
    ...diffOptions,
    document: documentSpec,
    plugins,
    theme,
    fontSize,
    lineHeight,
    inputLabel: `Diff ${side}: ${file.path}`,
    onChange() {
      const snap = controller.getSnapshot();
      if (snap) emitScrollTop(side, snap.viewport.scrollTop);
    },
  });

  const { ref: mountRef } = controller;

  useEffect(() => {
    emitEditorRef(side, controller.getEditor());
    return () => {
      emitEditorRef(side, null);
    };
  }, [controller, documentSpec, side]);

  return (
    <div ref={mountRef} className="wb-diff-pane" data-diff-side={side} data-testid={`wb-diff-pane-${side}`} />
  );
}

/**
 * Shared Singapore diff viewer supporting stacked (unified) and split side-by-side modes over a
 * shared `DiffRegionStore` with synchronized split scroll and reactive `--wb-*` theming.
 */
export function DiffEditorView({
  file: suppliedFile,
  path = "diff.txt",
  originalText,
  modifiedText,
  mode = "split",
  regions: suppliedRegions,
  themeVersion,
  fontSize = 13,
  lineHeight = 20,
  emptyMessage = "No differences to display.",
  className,
}: DiffEditorViewProps) {
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);
  const [theme, setTheme] = useState<EditorTheme>(() => buildWorkbenchEditorTheme(null));
  const [localRegions] = useState<DiffRegionStore>(() => createDiffRegionStore());
  const regions = suppliedRegions ?? localRegions;

  const editorsRef = useRef<Partial<Record<DiffGutterSide, Editor | null>>>({});
  const syncingScrollRef = useRef(false);

  useEffect(() => {
    if (!hostEl) return;
    const sync = (): void => setTheme(buildWorkbenchEditorTheme(hostEl));
    sync();
    return observeWorkbenchTheme(hostEl, sync, { themeVersion });
  }, [hostEl, themeVersion]);

  const diffFile = useMemo<DiffFile | null>(() => {
    if (suppliedFile !== undefined) return suppliedFile;
    if (originalText === undefined && modifiedText === undefined) return null;
    const languageId = languageIdForPath(path);
    return createTextDiff({
      oldFile: originalText !== undefined ? { path, text: originalText, languageId } : null,
      newFile: modifiedText !== undefined ? { path, text: modifiedText, languageId } : null,
    });
  }, [modifiedText, originalText, path, suppliedFile]);

  function handleEditorRef(side: DiffGutterSide, editor: Editor | null): void {
    editorsRef.current[side] = editor;
  }

  function handleScrollTop(side: DiffGutterSide, top: number): void {
    if (mode !== "split" || syncingScrollRef.current) return;
    const peerSide: DiffGutterSide = side === "old" ? "new" : "old";
    const peer = editorsRef.current[peerSide];
    if (!peer) return;
    syncingScrollRef.current = true;
    try {
      peer.setScrollPosition({ top });
      syncingScrollRef.current = false;
    } catch (error) {
      syncingScrollRef.current = false;
      throw error;
    }
  }

  function renderDiffContent() {
    if (!diffFile) {
      return (
        <div className="wb-editor-state" data-testid="wb-diff-empty">
          <strong>{emptyMessage}</strong>
        </div>
      );
    }
    if (mode === "stacked") {
      return (
        <DiffSidePane
          file={diffFile}
          side="stacked"
          regions={regions}
          theme={theme}
          fontSize={fontSize}
          lineHeight={lineHeight}
        />
      );
    }
    return (
      <div className="wb-diff-split">
        <DiffSidePane
          file={diffFile}
          side="old"
          regions={regions}
          theme={theme}
          fontSize={fontSize}
          lineHeight={lineHeight}
          onEditorRef={handleEditorRef}
          onScrollTop={handleScrollTop}
        />
        <DiffSidePane
          file={diffFile}
          side="new"
          regions={regions}
          theme={theme}
          fontSize={fontSize}
          lineHeight={lineHeight}
          onEditorRef={handleEditorRef}
          onScrollTop={handleScrollTop}
        />
      </div>
    );
  }

  return (
    <div
      ref={setHostEl}
      data-wb-diff=""
      data-diff-mode={mode}
      data-testid="wb-diff-view"
      className={cx("editor-diff-view wb-diff-view", className)}
    >
      {renderDiffContent()}
    </div>
  );
}
