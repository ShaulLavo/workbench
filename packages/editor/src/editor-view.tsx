import { useEffect, useEffectEvent, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  dismissSoftKeyboardOnTouchActivation,
  type ActivationFocusDecision,
  type DocumentId,
  type EditorDocumentAdapter,
  type LoadedDocument,
  type WriteOutcome,
} from "@shaulavo/workbench-core";
import { useSubscribable } from "@shaulavo/workbench-core/react";
import { observeWorkbenchTheme, type ThemeVersionSource } from "@shaulavo/workbench-tokens";
import { cx } from "@shaulavo/workbench-ui";
import type { Editor, EditorScrollPosition, EditorState } from "@singapore-editor/core/editor";
import type { EditorPlugin } from "@singapore-editor/core/extensions";
import type { EditorTheme } from "@singapore-editor/core/rendering";
import type { HighlightingService, HighlightingThemeSource } from "@singapore-editor/highlighting";
import { useEditor } from "@singapore-editor/react";
import { languageIdForPath } from "./utils/language";
import { DEFAULT_MAX_ANALYSIS_BYTES, documentFeatureTier } from "./utils/large-file";
import { createWorkbenchEditorPlugins } from "./utils/plugins";
import { capOverscrollTop, scrollPositionFromSnapshot } from "./utils/scroll";
import { buildWorkbenchEditorTheme } from "./utils/theme";

export interface EditorViewProps {
  readonly adapter: EditorDocumentAdapter;
  readonly documentId: DocumentId;
  readonly path?: string;
  readonly active?: boolean;
  readonly readOnly?: boolean;
  /** Immutable per-activation focus decision carried from tab/tree/command activation. */
  readonly focusDecision?: ActivationFocusDecision;
  /** Monotonic activation revision so re-selecting the same tab re-applies desktop focus. */
  readonly focusSeq?: number;
  readonly themeVersion?: ThemeVersionSource;
  readonly fontSize?: number;
  readonly lineHeight?: number;
  readonly wordWrap?: boolean;
  readonly scrollPastEnd?: boolean;
  readonly initialScrollPosition?: EditorScrollPosition;
  readonly highlightingService?: HighlightingService | null;
  readonly highlightingTheme?: HighlightingThemeSource;
  readonly extraPlugins?: readonly EditorPlugin[];
  readonly onDirtyChange?: (documentId: DocumentId, dirty: boolean) => void;
  readonly onSave?: (documentId: DocumentId) => void;
  readonly onWriteConflict?: (
    documentId: DocumentId,
    outcome: Extract<WriteOutcome, { readonly written: false }>,
  ) => void;
  readonly onScrollChange?: (documentId: DocumentId, position: EditorScrollPosition) => void;
  readonly onCursorChange?: (cursor: { readonly row: number; readonly column: number }) => void;
  readonly onEditorReady?: (editor: Editor | null) => void;
  readonly className?: string;
}

interface LoadedState {
  readonly documentId: DocumentId;
  readonly status: "loading" | "ready" | "missing" | "error";
  readonly doc: LoadedDocument | null;
  readonly error?: string;
}

function readNarrowViewport(): boolean {
  return typeof matchMedia === "function" && matchMedia("(max-width: 768px)").matches;
}

/**
 * Singapore React 19 code editor view over `EditorDocumentAdapter`.
 * Enforces per-activation touch focus policy across async document loads, degrades heavy analysis
 * cleanly above `maxAnalysisBytes`, renders external conflict resolution controls, and projects
 * `--wb-*` / `--wb-syn-*` tokens live onto Singapore's `EditorTheme`.
 */
export function EditorView({
  adapter,
  documentId,
  path,
  active = true,
  readOnly = false,
  focusDecision,
  focusSeq = 0,
  themeVersion,
  fontSize = 13,
  lineHeight = 20,
  wordWrap = false,
  scrollPastEnd = true,
  initialScrollPosition,
  highlightingService,
  highlightingTheme,
  extraPlugins,
  onDirtyChange,
  onSave,
  onWriteConflict,
  onScrollChange,
  onCursorChange,
  onEditorReady,
  className,
}: EditorViewProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);
  const [narrowViewport, setNarrowViewport] = useState<boolean>(() => readNarrowViewport());
  const [theme, setTheme] = useState<EditorTheme>(() => buildWorkbenchEditorTheme(null));
  const [loaded, setLoaded] = useState<LoadedState>({
    documentId,
    status: "loading",
    doc: null,
  });
  const [resolvingConflict, setResolvingConflict] = useState(false);

  const conflictSource = useMemo(() => adapter.getConflict(documentId), [adapter, documentId]);
  const conflict = useSubscribable(conflictSource);

  const revisionRef = useRef<string | undefined>(undefined);
  const dirtyRef = useRef(false);
  const appliedFocusSeqRef = useRef<number>(-1);
  const restoredScrollDocRef = useRef<string | null>(null);

  const emitDirty = useEffectEvent((id: DocumentId, nextDirty: boolean) => {
    onDirtyChange?.(id, nextDirty);
  });
  const emitSave = useEffectEvent((id: DocumentId) => {
    onSave?.(id);
  });
  const emitWriteConflict = useEffectEvent(
    (id: DocumentId, outcome: Extract<WriteOutcome, { readonly written: false }>) => {
      onWriteConflict?.(id, outcome);
    },
  );
  const emitScroll = useEffectEvent((id: DocumentId, position: EditorScrollPosition) => {
    onScrollChange?.(id, position);
  });
  const emitCursor = useEffectEvent((cursor: { readonly row: number; readonly column: number }) => {
    onCursorChange?.(cursor);
  });
  const emitEditorReady = useEffectEvent((editor: Editor | null) => {
    onEditorReady?.(editor);
  });

  // Load document whenever adapter or documentId changes, cancelling stale loads cleanly.
  useEffect(() => {
    let cancelled = false;
    dirtyRef.current = false;
    restoredScrollDocRef.current = null;
    void adapter
      .loadDocument(documentId)
      .then((doc) => {
        if (cancelled) return;
        if (!doc) {
          revisionRef.current = undefined;
          setLoaded({ documentId, status: "missing", doc: null });
          return;
        }
        revisionRef.current = doc.revision;
        setLoaded({ documentId, status: "ready", doc });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoaded({
          documentId,
          status: "error",
          doc: null,
          error: cause instanceof Error ? cause.message : "Failed to load document",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [adapter, documentId]);

  // Reactive workbench CSS token & viewport observation.
  useEffect(() => {
    if (!hostEl) return;
    const syncTheme = (): void => {
      setTheme(buildWorkbenchEditorTheme(hostEl));
    };
    syncTheme();
    const stopTheme = observeWorkbenchTheme(hostEl, syncTheme, { themeVersion });
    const media = typeof matchMedia === "function" ? matchMedia("(max-width: 768px)") : undefined;
    const onMedia = (): void => setNarrowViewport(readNarrowViewport());
    media?.addEventListener("change", onMedia);
    return () => {
      stopTheme();
      media?.removeEventListener("change", onMedia);
    };
  }, [hostEl, themeVersion]);

  const effectiveLoaded = loaded.documentId === documentId ? loaded : null;
  const currentDoc = effectiveLoaded?.status === "ready" ? effectiveLoaded.doc : null;
  const maxBytes = adapter.maxAnalysisBytes ?? DEFAULT_MAX_ANALYSIS_BYTES;
  const tier = documentFeatureTier(currentDoc?.byteLength ?? 0, maxBytes);
  const languageId = currentDoc?.languageId
    ? (currentDoc.languageId as ReturnType<typeof languageIdForPath>)
    : languageIdForPath(path ?? documentId);

  const plugins = useMemo(
    () =>
      createWorkbenchEditorPlugins({
        languageId,
        analysisAllowed: tier.analysisAllowed,
        narrowViewport,
        highlightingService,
        highlightingTheme,
        extraPlugins,
      }),
    [languageId, tier.analysisAllowed, narrowViewport, highlightingService, highlightingTheme, extraPlugins],
  );

  const editorDocument = useMemo(() => {
    if (!currentDoc) return null;
    return {
      documentId: `${documentId}@${currentDoc.revision}`,
      defaultText: currentDoc.text,
      languageId: tier.analysisAllowed ? languageId : null,
      scrollPosition: initialScrollPosition,
    };
  }, [currentDoc, documentId, initialScrollPosition, languageId, tier.analysisAllowed]);

  const effectiveReadOnly = readOnly || Boolean(currentDoc?.readOnly);

  const controller = useEditor({
    document: editorDocument,
    editability: effectiveReadOnly ? "readonly" : "editable",
    theme,
    plugins,
    fontSize,
    lineHeight,
    wordWrap,
    scrollPastEnd,
    inputLabel: path ? `Editor: ${path}` : "Editor input",
    onChange(state: EditorState) {
      emitCursor(state.cursor);
      if (state.isDirty !== dirtyRef.current) {
        dirtyRef.current = state.isDirty;
        emitDirty(documentId, state.isDirty);
      }
      const snap = controller.getSnapshot();
      const pos = scrollPositionFromSnapshot(snap);
      if (pos) emitScroll(documentId, pos);
    },
  });

  // Destructure ref callback first so React Compiler never flags controller reads as ref access.
  const { ref: editorMountRef, commands } = controller;

  useEffect(() => {
    emitEditorReady(controller.getEditor());
    return () => {
      emitEditorReady(null);
    };
  }, [controller, editorDocument]);

  // Clamp restored scroll top so overscroll never leaves blank space when reopening a file.
  useEffect(() => {
    if (!currentDoc || !initialScrollPosition || initialScrollPosition.top === undefined) return;
    if (restoredScrollDocRef.current === `${documentId}@${currentDoc.revision}`) return;
    const snap = controller.getSnapshot();
    if (!snap) return;
    restoredScrollDocRef.current = `${documentId}@${currentDoc.revision}`;
    const clampedTop = capOverscrollTop(initialScrollPosition.top, snap);
    if (clampedTop !== initialScrollPosition.top) {
      commands.setScrollPosition({ left: initialScrollPosition.left ?? 0, top: clampedTop });
    }
  }, [commands, controller, currentDoc, documentId, initialScrollPosition]);

  // Apply immutable per-activation focus decision after load settles.
  useEffect(() => {
    if (!active || !currentDoc || !controller.getEditor()) return;
    if (!focusDecision) return;
    const key = focusSeq;
    if (appliedFocusSeqRef.current === key) return;
    appliedFocusSeqRef.current = key;
    if (focusDecision.shouldFocusEditor) {
      commands.focus();
    } else {
      dismissSoftKeyboardOnTouchActivation(focusDecision, rootRef.current);
    }
  }, [active, commands, controller, currentDoc, focusDecision, focusSeq]);

  async function persistCurrentDocument(forceOverwrite = false): Promise<void> {
    if (effectiveReadOnly || !currentDoc) return;
    const nextText = controller.materializeFullText();
    const expected = forceOverwrite ? undefined : revisionRef.current;
    const outcome = await adapter.writeIfUnchanged(documentId, nextText, expected);
    if (outcome.written) {
      revisionRef.current = outcome.nextRevision;
      dirtyRef.current = false;
      emitDirty(documentId, false);
      await adapter.save(documentId);
      emitSave(documentId);
      return;
    }
    emitWriteConflict(documentId, outcome);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const isMod = event.metaKey || event.ctrlKey;
    if (isMod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void persistCurrentDocument();
    }
  }

  async function handleResolveConflict(choice: "keep-mine" | "take-theirs"): Promise<void> {
    if (!adapter.resolveConflict || resolvingConflict) return;
    setResolvingConflict(true);
    try {
      await adapter.resolveConflict(documentId, choice);
      if (choice === "take-theirs") {
        const fresh = await adapter.loadDocument(documentId);
        if (fresh) {
          revisionRef.current = fresh.revision;
          dirtyRef.current = false;
          emitDirty(documentId, false);
          setLoaded({ documentId, status: "ready", doc: fresh });
        }
      } else {
        await persistCurrentDocument(true);
      }
      setResolvingConflict(false);
    } catch (error) {
      setResolvingConflict(false);
      throw error;
    }
  }

  return (
    <div
      ref={(el) => {
        rootRef.current = el;
        setHostEl(el);
      }}
      tabIndex={-1}
      data-wb-editor=""
      data-document-id={documentId}
      data-language-id={languageId ?? "plain"}
      data-analysis-allowed={tier.analysisAllowed ? "true" : "false"}
      data-readonly={effectiveReadOnly ? "true" : "false"}
      data-status={effectiveLoaded?.status ?? "loading"}
      className={cx("wb-editor-view", className)}
      onKeyDown={handleKeyDown}
    >
      {conflict ? (
        <div
          className="wb-editor-banner wb-editor-conflict-bar"
          role="alert"
          data-testid="wb-editor-conflict-bar"
        >
          <span className="wb-editor-banner-text">
            {conflict.diskText === undefined
              ? `${conflict.path ?? documentId} was deleted on disk.`
              : `${conflict.path ?? documentId} changed on disk.`}
          </span>
          {adapter.resolveConflict ? (
            <div className="wb-editor-banner-actions">
              <button
                type="button"
                className="wb-button wb-button-primary"
                data-testid="wb-editor-conflict-keep"
                disabled={resolvingConflict}
                onClick={() => void handleResolveConflict("keep-mine")}
              >
                Keep mine
              </button>
              <button
                type="button"
                className="wb-button"
                data-testid="wb-editor-conflict-theirs"
                disabled={resolvingConflict}
                onClick={() => void handleResolveConflict("take-theirs")}
              >
                Take theirs
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {currentDoc && !tier.analysisAllowed ? (
        <div
          className="wb-editor-banner wb-editor-large-file-notice"
          role="status"
          data-testid="wb-editor-large-file-notice"
        >
          Large file ({Math.round(currentDoc.byteLength / 1024)} KB) — syntax highlighting and analysis
          disabled for responsiveness.
        </div>
      ) : null}

      {effectiveLoaded?.status === "error" ? (
        <div className="wb-editor-state" role="alert" data-testid="wb-editor-error">
          <strong>Unable to load document</strong>
          <p>{effectiveLoaded.error}</p>
        </div>
      ) : effectiveLoaded?.status === "missing" ? (
        <div className="wb-editor-state" data-testid="wb-editor-missing">
          <strong>File not found</strong>
          <p>{path ?? documentId}</p>
        </div>
      ) : (
        <div
          ref={editorMountRef}
          className="wb-editor-surface"
          data-testid="wb-editor-surface"
          aria-busy={effectiveLoaded?.status !== "ready"}
        />
      )}
    </div>
  );
}
