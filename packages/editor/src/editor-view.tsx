import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  dismissSoftKeyboardOnTouchActivation,
  type ActivationFocusDecision,
  type DocumentId,
  type EditorDocumentAdapter,
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
import {
  getDocumentDraft,
  isDraftDirty,
  persistDocumentDraft,
  recordDocumentEdit,
  replaceDocumentDraftFromDisk,
  seedDocumentDraft,
  subscribeDocumentDraft,
  type DocumentDraftEntry,
} from "./utils/draft-store";
import { languageIdForPath } from "./utils/language";
import { DEFAULT_MAX_ANALYSIS_BYTES, documentFeatureTier } from "./utils/large-file";
import { createWorkbenchEditorPlugins } from "./utils/plugins";
import { capOverscrollTop } from "./utils/scroll";
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

interface ReadyDocumentSnapshot {
  readonly text: string;
  readonly languageId?: string;
  readonly byteLength: number;
  readonly readOnly?: boolean;
  readonly reloadSeq: number;
}

interface LoadedState {
  readonly documentId: DocumentId;
  readonly status: "loading" | "ready" | "missing" | "error";
  readonly doc: ReadyDocumentSnapshot | null;
  readonly error?: string;
}

function readNarrowViewport(): boolean {
  return typeof matchMedia === "function" && matchMedia("(max-width: 768px)").matches;
}

function snapshotFromDraft(entry: DocumentDraftEntry): ReadyDocumentSnapshot {
  return {
    text: entry.text,
    languageId: entry.languageId,
    byteLength: entry.byteLength,
    readOnly: entry.readOnly,
    reloadSeq: entry.reloadSeq,
  };
}

function resolveEffectiveLoaded(
  loaded: LoadedState,
  documentId: DocumentId,
  cachedDraft: DocumentDraftEntry | undefined,
): LoadedState | null {
  if (loaded.documentId === documentId) return loaded;
  if (!cachedDraft) return null;
  return { documentId, status: "ready", doc: snapshotFromDraft(cachedDraft) };
}

/**
 * Singapore React 19 code editor view over `EditorDocumentAdapter`.
 * Preserves unsaved drafts across tab switches and split rearrangements, serializes saves per
 * document, enforces per-activation touch focus policy across async loads, degrades heavy analysis
 * cleanly above `maxAnalysisBytes`, and projects `--wb-*` / `--wb-syn-*` tokens onto Singapore.
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
  const [loaded, setLoaded] = useState<LoadedState>(() => {
    const existing = getDocumentDraft(adapter, documentId);
    if (existing) return { documentId, status: "ready", doc: snapshotFromDraft(existing) };
    return { documentId, status: "loading", doc: null };
  });
  const [resolvingConflictDocId, setResolvingConflictDocId] = useState<DocumentId | null>(null);

  const conflictSource = useMemo(() => adapter.getConflict(documentId), [adapter, documentId]);
  const conflict = useSubscribable(conflictSource);

  const activeDocIdRef = useRef<DocumentId>(documentId);
  const committedDocIdRef = useRef<DocumentId | null>(null);
  const dirtyByDocRef = useRef<Map<DocumentId, boolean>>(new Map());
  const appliedFocusSeqRef = useRef<number>(-1);
  const restoredScrollDocRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    activeDocIdRef.current = documentId;
  }, [documentId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const emitDirty = useEffectEvent((id: DocumentId, nextDirty: boolean) => {
    if (dirtyByDocRef.current.get(id) === nextDirty) return;
    dirtyByDocRef.current.set(id, nextDirty);
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

  // Restore live draft immediately when present; otherwise load from adapter with stale-load cancellation.
  useEffect(() => {
    let cancelled = false;
    restoredScrollDocRef.current = null;

    const existing = getDocumentDraft(adapter, documentId);
    if (existing) {
      dirtyByDocRef.current.set(documentId, isDraftDirty(existing));
      setLoaded({ documentId, status: "ready", doc: snapshotFromDraft(existing) });
      return () => {
        cancelled = true;
      };
    }

    void adapter
      .loadDocument(documentId)
      .then((doc) => {
        if (cancelled) return;
        if (!doc) {
          setLoaded({ documentId, status: "missing", doc: null });
          return;
        }
        const draft = seedDocumentDraft(adapter, documentId, doc);
        dirtyByDocRef.current.set(documentId, isDraftDirty(draft));
        setLoaded({ documentId, status: "ready", doc: snapshotFromDraft(draft) });
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

  const cachedDraft = getDocumentDraft(adapter, documentId);
  const effectiveLoaded = resolveEffectiveLoaded(loaded, documentId, cachedDraft);

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
      documentId: `${documentId}@${currentDoc.reloadSeq}`,
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
      if (committedDocIdRef.current !== documentId) return;
      const nextText = controller.materializeFullText();
      const dirty = recordDocumentEdit(adapter, documentId, nextText);
      emitDirty(documentId, dirty);
    },
  });

  // Destructure ref callback first so React Compiler never flags controller reads as ref access.
  const { ref: editorMountRef, commands } = controller;

  useLayoutEffect(() => {
    committedDocIdRef.current = currentDoc ? documentId : null;
    return () => {
      committedDocIdRef.current = null;
    };
  }, [currentDoc, documentId]);

  useEffect(() => {
    const editor = controller.getEditor();
    emitEditorReady(editor);
    const scrollSub = editor?.onDidScroll((position) => {
      emitScroll(documentId, position);
    });
    return () => {
      scrollSub?.dispose();
      emitEditorReady(null);
    };
  }, [controller, documentId, editorDocument]);

  // Clamp restored scroll top so overscroll never leaves blank space when reopening a file.
  useEffect(() => {
    if (!currentDoc || !initialScrollPosition || initialScrollPosition.top === undefined) return;
    const key = `${documentId}@${currentDoc.reloadSeq}`;
    if (restoredScrollDocRef.current === key) return;
    const snap = controller.getSnapshot();
    if (!snap) return;
    restoredScrollDocRef.current = key;
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

  // Keep split panes displaying the same documentId in sync on authoritative reloads ("Take theirs").
  useEffect(() => {
    if (!currentDoc) return;
    return subscribeDocumentDraft(adapter, documentId, () => {
      const latest = getDocumentDraft(adapter, documentId);
      if (!latest || !mountedRef.current || activeDocIdRef.current !== documentId) return;
      emitDirty(documentId, isDraftDirty(latest));
      setLoaded({ documentId, status: "ready", doc: snapshotFromDraft(latest) });
    });
  }, [adapter, currentDoc, documentId]);

  function triggerPersist(targetDocId: DocumentId, forceOverwrite = false): Promise<void> {
    if (effectiveReadOnly) return Promise.resolve();
    if (activeDocIdRef.current === targetDocId && committedDocIdRef.current === targetDocId) {
      recordDocumentEdit(adapter, targetDocId, controller.materializeFullText());
    }
    return persistDocumentDraft(adapter, targetDocId, forceOverwrite, {
      onDirtyChange: emitDirty,
      onSave: emitSave,
      onWriteConflict: emitWriteConflict,
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const isMod = event.metaKey || event.ctrlKey;
    if (isMod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void triggerPersist(documentId, false);
    }
  }

  async function applyTakeTheirs(targetDocId: DocumentId): Promise<void> {
    const fresh = await adapter.loadDocument(targetDocId);
    if (!fresh) return;
    replaceDocumentDraftFromDisk(adapter, targetDocId, fresh);
    emitDirty(targetDocId, false);
  }

  async function handleResolveConflict(choice: "keep-mine" | "take-theirs"): Promise<void> {
    const targetDocId = documentId;
    if (!adapter.resolveConflict || resolvingConflictDocId === targetDocId) return;
    if (choice === "keep-mine" && committedDocIdRef.current === targetDocId) {
      recordDocumentEdit(adapter, targetDocId, controller.materializeFullText());
    }
    setResolvingConflictDocId(targetDocId);
    try {
      await adapter.resolveConflict(targetDocId, choice);
      if (choice === "take-theirs") {
        await applyTakeTheirs(targetDocId);
      } else {
        await persistDocumentDraft(adapter, targetDocId, true, {
          onDirtyChange: emitDirty,
          onSave: emitSave,
          onWriteConflict: emitWriteConflict,
        });
      }
      if (mountedRef.current) setResolvingConflictDocId(null);
    } catch (error) {
      if (mountedRef.current) setResolvingConflictDocId(null);
      throw error;
    }
  }

  const resolvingCurrentConflict = resolvingConflictDocId === documentId;

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
          <span>External change detected on {conflict.path ?? conflict.documentId}.</span>
          <div className="wb-editor-banner-actions">
            <button
              type="button"
              className="wb-button"
              disabled={resolvingCurrentConflict}
              data-testid="wb-editor-conflict-keep"
              onClick={() => void handleResolveConflict("keep-mine")}
            >
              Keep mine
            </button>
            <button
              type="button"
              className="wb-button wb-button-primary"
              disabled={resolvingCurrentConflict}
              data-testid="wb-editor-conflict-theirs"
              onClick={() => void handleResolveConflict("take-theirs")}
            >
              Take theirs
            </button>
          </div>
        </div>
      ) : null}

      {currentDoc && !tier.analysisAllowed ? (
        <div
          className="wb-editor-banner wb-editor-large-file"
          role="status"
          data-testid="wb-editor-large-file-notice"
        >
          Large file ({Math.round(currentDoc.byteLength / (1024 * 1024))} MiB): syntax highlighting and
          diagnostics disabled for responsiveness.
        </div>
      ) : null}

      {effectiveLoaded?.status === "missing" ? (
        <div className="wb-editor-state" data-testid="wb-editor-missing">
          <strong>File not found</strong>
          <p>{path ?? documentId}</p>
        </div>
      ) : null}

      {effectiveLoaded?.status === "error" ? (
        <div className="wb-editor-state" role="alert" data-testid="wb-editor-error">
          <strong>Unable to open document</strong>
          <p>{effectiveLoaded.error}</p>
        </div>
      ) : null}

      {currentDoc ? (
        <div ref={editorMountRef} className="wb-editor-surface" data-testid="wb-editor-surface" />
      ) : null}
    </div>
  );
}
