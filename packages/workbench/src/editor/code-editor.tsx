import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEventHandler,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import {
  dismissSoftKeyboardOnTouchActivation,
  type ActivationFocusDecision,
  type DocumentId,
  type EditorDocumentAdapter,
  type WriteOutcome,
} from "../core/index";
import { useSubscribable, useViewportMode } from "../core/react/index";
import { observeWorkbenchTheme, type ThemeVersionSource } from "../tokens/index";
import { cx } from "../ui/index";
import {
  createEditorBufferSession,
  createEditorViewSession,
  type EditorBufferSession,
  type EditorTextBuffer,
} from "@singapore-editor/core/document";
import type { Editor, EditorOptions, EditorScrollPosition, EditorState } from "@singapore-editor/core/editor";
import type { EditorPlugin } from "@singapore-editor/core/extensions";
import type { EditorTheme } from "@singapore-editor/core/rendering";
import type { FoldGutterIcon } from "@singapore-editor/gutters/fold-gutter";
import type { HighlightingService, HighlightingThemeSource } from "@singapore-editor/highlighting";
import { useEditor, useEditorSelector, type ReactEditorStoreSnapshot } from "@singapore-editor/react";
import {
  getDocumentDraft,
  isDraftDirty,
  persistDocumentDraft,
  resolveDocumentConflict,
  seedDocumentDraft,
  subscribeDocumentDraft,
} from "./utils/draft-store";
import { languageIdForPath } from "./utils/language";
import { DEFAULT_MAX_ANALYSIS_BYTES, documentFeatureTier } from "./utils/large-file";
import { createWorkbenchEditorPlugins } from "./utils/plugins";
import { clampRestoredScroll } from "./utils/scroll";
import { buildWorkbenchEditorTheme } from "./utils/theme";

export interface EditorSessionAttachment {
  readonly session: EditorBufferSession;
  /** Document URI/path passed to Singapore (null for detached drafts so LSP ignores them). */
  readonly documentId: string | null;
  readonly languageId?: string | null;
  readonly scrollPosition?: EditorScrollPosition;
}

export interface EditorRevealTarget {
  readonly line?: number;
  readonly column?: number;
  readonly focus?: boolean;
  readonly seq: number;
}

export interface CodeEditorCommonProps {
  readonly readOnly?: boolean;
  readonly themeOverride?: EditorTheme;
  readonly themeVersion?: ThemeVersionSource;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly lineHeight?: number;
  readonly gutterLeadingInset?: number;
  readonly scrollPastEnd?: boolean;
  readonly wordWrap?: boolean;
  readonly wordWrapBreak?: EditorOptions["wordWrapBreak"];
  readonly cursorLineHighlight?: EditorOptions["cursorLineHighlight"];
  readonly narrowViewport?: boolean;
  /**
   * Syntax highlighting configuration. Enabled by default when `analysisAllowed` is true;
   * pass `false` to disable or a custom `HighlightingService` instance.
   */
  readonly highlighting?: false | HighlightingService;
  readonly highlightingTheme?: HighlightingThemeSource;
  readonly foldIcons?: {
    readonly expandedIcon?: FoldGutterIcon;
    readonly collapsedIcon?: FoldGutterIcon;
  };
  readonly includeMergeConflict?: boolean;
  readonly extraPlugins?: readonly EditorPlugin[];
  readonly onEditorReady?: (editor: Editor | null) => void;
  readonly onChange?: (state: EditorState, editor: Editor) => void;
  readonly onBlur?: FocusEventHandler<HTMLDivElement>;
  readonly onContextMenu?: MouseEventHandler<HTMLDivElement>;
  readonly onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  readonly className?: string;
  readonly hostClassName?: string;
  readonly hostTestId?: string;
}

export interface CodeEditorAdapterProps extends CodeEditorCommonProps {
  readonly adapter: EditorDocumentAdapter;
  readonly documentId: DocumentId;
  readonly session?: never;
  readonly path?: string;
  readonly active?: boolean;
  /** Immutable per-activation focus decision carried from tab/tree/command activation. */
  readonly focusDecision?: ActivationFocusDecision;
  /** Monotonic activation revision so re-selecting the same tab re-applies desktop focus. */
  readonly focusSeq?: number;
  readonly initialScrollPosition?: EditorScrollPosition;
  readonly onDirtyChange?: (documentId: DocumentId, dirty: boolean) => void;
  readonly onSave?: (documentId: DocumentId) => void;
  readonly onWriteConflict?: (
    documentId: DocumentId,
    outcome: Extract<WriteOutcome, { readonly written: false }>,
  ) => void;
  readonly onScrollChange?: (documentId: DocumentId, position: EditorScrollPosition) => void;
  readonly onCursorChange?: (cursor: { readonly row: number; readonly column: number }) => void;
}

export interface CodeEditorSessionProps extends CodeEditorCommonProps {
  /** Currently attached session, or `null` when no file is open (detaches without unmounting the editor). */
  readonly session: EditorSessionAttachment | null;
  readonly adapter?: never;
  readonly documentId?: never;
  readonly reveal?: EditorRevealTarget | null;
  readonly onBeforeDetach?: (
    attachment: EditorSessionAttachment,
    scrollPosition: EditorScrollPosition,
  ) => void;
  readonly onAttached?: (editor: Editor, attachment: EditorSessionAttachment) => void;
  readonly onDetached?: (editor: Editor) => void;
  readonly emptyState?: ReactNode;
}

export type CodeEditorProps = CodeEditorAdapterProps | CodeEditorSessionProps;

interface DraftViewSnapshot {
  readonly buffer: EditorTextBuffer;
  readonly languageId: string | undefined;
  readonly readOnly: boolean;
  readonly analysisAllowed: boolean;
  readonly largeFileMiB: number;
  readonly dirty: boolean;
  readonly resolvingConflict: boolean;
  readonly reloadSeq: number;
}

interface LoadFailureState {
  readonly documentId: DocumentId;
  readonly status: "missing" | "error";
  readonly error?: string;
}

interface CodeEditorSurfaceProps extends CodeEditorCommonProps {
  readonly attachment: EditorSessionAttachment | null;
  readonly documentIdAttr?: string;
  readonly languageIdAttr?: string | null;
  readonly analysisAllowed: boolean;
  readonly status: "loading" | "ready" | "missing" | "error" | "empty";
  readonly active?: boolean;
  readonly inputLabel?: string;
  readonly focusDecision?: ActivationFocusDecision;
  readonly focusSeq?: number;
  readonly reveal?: EditorRevealTarget | null;
  readonly onBeforeDetach?: (
    attachment: EditorSessionAttachment,
    scrollPosition: EditorScrollPosition,
  ) => void;
  readonly onAttached?: (editor: Editor, attachment: EditorSessionAttachment) => void;
  readonly onDetached?: (editor: Editor) => void;
  readonly onScroll?: (position: EditorScrollPosition) => void;
  readonly onContainerKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  readonly bannerSlot?: ReactNode;
  readonly stateSlot?: ReactNode;
}

const selectEditorInstance = (snapshot: ReactEditorStoreSnapshot): Editor | null => snapshot.editor;

function isAdapterProps(props: CodeEditorProps): props is CodeEditorAdapterProps {
  return "adapter" in props && props.adapter !== undefined;
}

function computeRevealOffset(session: EditorBufferSession, line: number, column: number | undefined): number {
  const snapshot = session.getTextSnapshot();
  const row = Math.max(0, Math.min(line - 1, snapshot.lineCount - 1));
  const range = snapshot.lineRange(row);
  return Math.min(range.start + Math.max(0, (column ?? 1) - 1), range.end);
}

function applyClampedRestoredScroll(
  editor: Editor,
  savedScroll: EditorScrollPosition | undefined,
  hostHeight: number,
): void {
  if (savedScroll?.top === undefined) return;
  const clamped = clampRestoredScroll(savedScroll, editor.getContentHeight(), hostHeight);
  if (!clamped || clamped.top === editor.getScrollPosition().top) return;
  editor.setScrollPosition(clamped);
}

function sameDraftViewSnapshot(prev: DraftViewSnapshot | null, next: DraftViewSnapshot | null): boolean {
  if (prev === next) return true;
  if (!prev || !next) return false;
  return (
    prev.buffer === next.buffer &&
    prev.languageId === next.languageId &&
    prev.readOnly === next.readOnly &&
    prev.analysisAllowed === next.analysisAllowed &&
    prev.largeFileMiB === next.largeFileMiB &&
    prev.dirty === next.dirty &&
    prev.resolvingConflict === next.resolvingConflict &&
    prev.reloadSeq === next.reloadSeq
  );
}

function useDraftViewSnapshot(
  adapter: EditorDocumentAdapter,
  documentId: DocumentId,
  maxAnalysisBytes: number,
): DraftViewSnapshot | null {
  const cachedRef = useRef<DraftViewSnapshot | null>(null);

  const subscribe = useMemo(
    () => (onStoreChange: () => void) => subscribeDocumentDraft(adapter, documentId, onStoreChange),
    [adapter, documentId],
  );

  const getSnapshot = (): DraftViewSnapshot | null => {
    const entry = getDocumentDraft(adapter, documentId);
    if (!entry) {
      cachedRef.current = null;
      return null;
    }
    const tier = documentFeatureTier(entry.byteLength, maxAnalysisBytes);
    const next: DraftViewSnapshot = {
      buffer: entry.buffer,
      languageId: entry.languageId,
      readOnly: Boolean(entry.readOnly),
      analysisAllowed: tier.analysisAllowed,
      largeFileMiB: tier.analysisAllowed ? 0 : Math.round(entry.byteLength / (1024 * 1024)),
      dirty: isDraftDirty(entry),
      resolvingConflict: entry.resolvingConflict,
      reloadSeq: entry.reloadSeq,
    };
    if (sameDraftViewSnapshot(cachedRef.current, next)) {
      return cachedRef.current;
    }
    cachedRef.current = next;
    return next;
  };

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

function CodeEditorSurface({
  attachment,
  documentIdAttr,
  languageIdAttr,
  analysisAllowed,
  status,
  active = true,
  readOnly = false,
  themeOverride,
  themeVersion,
  fontFamily,
  fontSize = 13,
  lineHeight = 20,
  gutterLeadingInset,
  scrollPastEnd = true,
  wordWrap = false,
  wordWrapBreak = "word",
  cursorLineHighlight,
  narrowViewport: narrowProp,
  highlighting,
  highlightingTheme,
  foldIcons,
  includeMergeConflict = false,
  extraPlugins,
  inputLabel,
  focusDecision,
  focusSeq = 0,
  reveal,
  onBeforeDetach,
  onAttached,
  onDetached,
  onEditorReady,
  onChange,
  onScroll,
  onBlur,
  onContextMenu,
  onKeyDown,
  onContainerKeyDown,
  bannerSlot,
  stateSlot,
  className,
  hostClassName,
  hostTestId = "wb-editor-surface",
}: CodeEditorSurfaceProps) {
  const rootElRef = useRef<HTMLDivElement | null>(null);
  const hostElRef = useRef<HTMLDivElement | null>(null);
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);
  const detectedNarrow = useViewportMode() === "phone";
  const [tokenTheme, setTokenTheme] = useState<EditorTheme>(() => buildWorkbenchEditorTheme(null));
  const attachedRef = useRef<EditorSessionAttachment | null>(null);
  const handledRevealRef = useRef<number | null>(null);
  const appliedFocusSeqRef = useRef<number>(-1);

  const narrow = narrowProp ?? detectedNarrow;
  const theme = themeOverride ?? tokenTheme;
  const useDefaultHighlighting = highlighting === undefined;
  const highlightingService = highlighting === false ? null : (highlighting ?? null);

  const emitBeforeDetach = useEffectEvent(
    (current: EditorSessionAttachment, scroll: EditorScrollPosition) => {
      onBeforeDetach?.(current, scroll);
    },
  );
  const emitAttached = useEffectEvent((editor: Editor, current: EditorSessionAttachment) => {
    onAttached?.(editor, current);
  });
  const emitDetached = useEffectEvent((editor: Editor) => {
    onDetached?.(editor);
  });
  const emitEditorReady = useEffectEvent((editor: Editor | null) => {
    onEditorReady?.(editor);
  });
  const emitChange = useEffectEvent((state: EditorState, editor: Editor) => {
    onChange?.(state, editor);
  });
  const emitScroll = useEffectEvent((position: EditorScrollPosition) => {
    onScroll?.(position);
  });

  const plugins = useMemo(
    () =>
      createWorkbenchEditorPlugins({
        analysisAllowed,
        narrowViewport: narrow,
        useDefaultHighlighting,
        highlightingService,
        highlightingTheme,
        foldIcons,
        includeMergeConflict,
        extraPlugins,
      }),
    [
      analysisAllowed,
      narrow,
      useDefaultHighlighting,
      highlightingService,
      highlightingTheme,
      foldIcons,
      includeMergeConflict,
      extraPlugins,
    ],
  );

  const resolvedTheme = useMemo(() => theme, [theme]);

  const controller = useEditor({
    theme: resolvedTheme,
    plugins,
    fontFamily,
    fontSize,
    lineHeight,
    gutterLeadingInset,
    scrollPastEnd,
    cursorLineHighlight,
    wordWrap,
    wordWrapBreak,
    editability: readOnly ? "readonly" : "editable",
    inputLabel,
    storeSync: "none",
    onChange(state) {
      const instance = controller.getEditor();
      if (instance) emitChange(state, instance);
    },
  });
  const { ref: editorMountRef } = controller;
  const editor = useEditorSelector(controller, selectEditorInstance);

  // Reactive workbench CSS token observation.
  useEffect(() => {
    if (!hostEl || themeOverride) return;
    let mounted = true;
    const syncTheme = (): void => {
      if (!mounted) return;
      setTokenTheme(buildWorkbenchEditorTheme(hostEl));
    };
    const stopTheme = observeWorkbenchTheme(hostEl, syncTheme, { themeVersion });
    queueMicrotask(syncTheme);
    return () => {
      mounted = false;
      stopTheme();
    };
  }, [hostEl, themeOverride, themeVersion]);

  // Remeasure once custom web fonts finish loading so glyph metrics match the rendered face.
  useEffect(() => {
    if (!editor || !fontFamily || typeof document.fonts?.ready?.then !== "function") return;
    let disposed = false;
    void document.fonts.ready.then(() => {
      if (!disposed) editor.setFontFamily(fontFamily);
    });
    return () => {
      disposed = true;
    };
  }, [editor, fontFamily]);

  // Layout cleanup runs before React detaches the host ref and disposes the Singapore editor.
  useLayoutEffect(() => {
    if (!editor) return;
    return () => {
      const current = attachedRef.current;
      if (!current) return;
      attachedRef.current = null;
      emitBeforeDetach(current, editor.getScrollPosition());
      editor.detachSession();
      emitDetached(editor);
    };
  }, [editor]);

  useEffect(() => {
    emitEditorReady(editor);
    const scrollSub = editor?.onDidScroll((position) => {
      emitScroll(position);
    });
    return () => {
      scrollSub?.dispose();
      emitEditorReady(null);
    };
  }, [editor]);

  // Attach or detach the active buffer session while preserving scroll across switches.
  useEffect(() => {
    if (!editor) return;
    const current = attachedRef.current;

    if (!attachment) {
      if (!current) return;
      attachedRef.current = null;
      emitBeforeDetach(current, editor.getScrollPosition());
      editor.detachSession();
      editor.clear();
      emitDetached(editor);
      return;
    }

    const sameSession =
      current?.session === attachment.session &&
      current.documentId === attachment.documentId &&
      current.languageId === attachment.languageId;
    if (sameSession) return;

    const sameBufferSession = current?.session === attachment.session;
    const scrollToRestore = sameBufferSession ? editor.getScrollPosition() : attachment.scrollPosition;
    if (current && !sameBufferSession) {
      emitBeforeDetach(current, editor.getScrollPosition());
    }

    editor.attachSession(attachment.session, {
      documentId: attachment.documentId,
      languageId: attachment.languageId ?? null,
      scrollPosition: scrollToRestore,
    });
    applyClampedRestoredScroll(editor, scrollToRestore, hostElRef.current?.clientHeight ?? 0);
    attachedRef.current = attachment;
    emitAttached(editor, attachment);
  }, [editor, attachment]);

  // Apply reveal requests (jump to 1-based line/column and optional focus) strictly monotonically.
  useEffect(() => {
    if (!editor || !reveal || !attachedRef.current) return;
    if (handledRevealRef.current !== null && reveal.seq <= handledRevealRef.current) return;
    handledRevealRef.current = reveal.seq;
    if (reveal.line !== undefined) {
      const offset = computeRevealOffset(attachedRef.current.session, reveal.line, reveal.column);
      editor.jumpTo(offset, undefined, "go-to-line");
    }
    if (reveal.focus) editor.focus();
  }, [editor, reveal, attachment]);

  // Apply immutable per-activation focus decision after session attachment settles.
  useEffect(() => {
    if (!active || !editor || !attachment || !focusDecision) return;
    if (appliedFocusSeqRef.current === focusSeq) return;
    appliedFocusSeqRef.current = focusSeq;
    if (focusDecision.shouldFocusEditor) {
      editor.focus();
    } else {
      dismissSoftKeyboardOnTouchActivation(focusDecision, rootElRef.current);
    }
  }, [active, editor, attachment, focusDecision, focusSeq]);

  const attachHostRef = (element: HTMLDivElement | null) => {
    hostElRef.current = element;
    setHostEl(element);
    return editorMountRef(element);
  };

  return (
    <div
      ref={rootElRef}
      tabIndex={-1}
      data-wb-editor=""
      data-document-id={documentIdAttr}
      data-language-id={languageIdAttr ?? "plain"}
      data-analysis-allowed={analysisAllowed ? "true" : "false"}
      data-readonly={readOnly ? "true" : "false"}
      data-status={status}
      className={cx("wb-editor-view", className)}
      onKeyDown={onContainerKeyDown}
    >
      {bannerSlot}
      {stateSlot}
      <div
        ref={attachHostRef}
        className={cx("wb-editor-surface", hostClassName)}
        data-testid={hostTestId}
        onBlur={onBlur}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

function SessionCodeEditor({
  session,
  reveal,
  onBeforeDetach,
  onAttached,
  onDetached,
  emptyState,
  includeMergeConflict = false,
  ...common
}: CodeEditorSessionProps) {
  return (
    <CodeEditorSurface
      {...common}
      includeMergeConflict={includeMergeConflict}
      attachment={session}
      documentIdAttr={session?.documentId ?? undefined}
      languageIdAttr={session?.languageId ?? null}
      analysisAllowed={true}
      status={session ? "ready" : "empty"}
      reveal={reveal}
      onBeforeDetach={onBeforeDetach}
      onAttached={onAttached}
      onDetached={onDetached}
      stateSlot={!session ? emptyState : null}
    />
  );
}

function AdapterCodeEditor({
  adapter,
  documentId,
  path,
  active = true,
  readOnly = false,
  focusDecision,
  focusSeq = 0,
  initialScrollPosition,
  includeMergeConflict = true,
  onDirtyChange,
  onSave,
  onWriteConflict,
  onScrollChange,
  onCursorChange,
  onChange,
  ...common
}: CodeEditorAdapterProps) {
  const maxBytes = adapter.maxAnalysisBytes ?? DEFAULT_MAX_ANALYSIS_BYTES;
  const draft = useDraftViewSnapshot(adapter, documentId, maxBytes);
  const [loadFailure, setLoadFailure] = useState<LoadFailureState | null>(null);

  const conflictSource = useMemo(() => adapter.getConflict(documentId), [adapter, documentId]);
  const conflict = useSubscribable(conflictSource);

  const dirtyByDocRef = useRef<Map<DocumentId, boolean>>(new Map());
  const hasDraft = draft !== null;

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

  // Load from adapter when no shared draft exists yet, cancelling stale loads on document switch.
  useEffect(() => {
    if (hasDraft) return;
    let cancelled = false;
    void adapter
      .loadDocument(documentId)
      .then((doc) => {
        if (cancelled) return;
        if (!doc) {
          setLoadFailure({ documentId, status: "missing" });
          return;
        }
        const seeded = seedDocumentDraft(adapter, documentId, doc);
        dirtyByDocRef.current.set(documentId, isDraftDirty(seeded));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setLoadFailure({
          documentId,
          status: "error",
          error: cause instanceof Error ? cause.message : "Failed to load document",
        });
      });

    return () => {
      cancelled = true;
    };
  }, [adapter, documentId, hasDraft]);

  // Synchronize dirty transitions across panes sharing this live EditorTextBuffer.
  const draftDirty = draft?.dirty;
  useEffect(() => {
    if (draftDirty === undefined) return;
    emitDirty(documentId, draftDirty);
  }, [documentId, draftDirty]);

  // Each mounted pane owns its own EditorViewSession over the shared EditorTextBuffer.
  const buffer = draft?.buffer ?? null;
  const paneSession = useMemo<EditorBufferSession | null>(() => {
    if (!buffer) return null;
    return createEditorBufferSession(buffer, createEditorViewSession(buffer));
  }, [buffer]);

  const analysisAllowed = draft ? draft.analysisAllowed : true;
  const resolvedLanguageId = draft?.languageId
    ? (draft.languageId as ReturnType<typeof languageIdForPath>)
    : languageIdForPath(path ?? documentId);

  const attachment = useMemo<EditorSessionAttachment | null>(() => {
    if (!paneSession) return null;
    return {
      session: paneSession,
      documentId,
      languageId: analysisAllowed ? resolvedLanguageId : null,
      scrollPosition: initialScrollPosition,
    };
  }, [paneSession, documentId, analysisAllowed, resolvedLanguageId, initialScrollPosition]);

  const effectiveReadOnly = readOnly || Boolean(draft?.readOnly);
  const resolvingCurrentConflict = Boolean(draft?.resolvingConflict);
  const activeFailure = loadFailure?.documentId === documentId ? loadFailure : null;
  let status: "loading" | "ready" | "missing" | "error" = "loading";
  if (draft) {
    status = "ready";
  } else if (activeFailure) {
    status = activeFailure.status;
  }

  function handleContainerKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const isMod = event.metaKey || event.ctrlKey;
    if (!isMod || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    if (effectiveReadOnly) return;
    void persistDocumentDraft(adapter, documentId, false, {
      onDirtyChange: emitDirty,
      onSave: emitSave,
      onWriteConflict: emitWriteConflict,
    });
  }

  function handleResolveConflict(choice: "keep-mine" | "take-theirs"): void {
    if (choice === "keep-mine" && effectiveReadOnly) return;
    void resolveDocumentConflict(adapter, documentId, choice, {
      onDirtyChange: emitDirty,
      onSave: emitSave,
      onWriteConflict: emitWriteConflict,
    });
  }

  const bannerSlot = (
    <>
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
              disabled={effectiveReadOnly || resolvingCurrentConflict}
              data-testid="wb-editor-conflict-keep"
              onClick={() => handleResolveConflict("keep-mine")}
            >
              Keep mine
            </button>
            <button
              type="button"
              className="wb-button wb-button-primary"
              disabled={resolvingCurrentConflict}
              data-testid="wb-editor-conflict-theirs"
              onClick={() => handleResolveConflict("take-theirs")}
            >
              Take theirs
            </button>
          </div>
        </div>
      ) : null}

      {draft && !draft.analysisAllowed ? (
        <div
          className="wb-editor-banner wb-editor-large-file"
          role="status"
          data-testid="wb-editor-large-file-notice"
        >
          Large file ({draft.largeFileMiB} MiB): syntax highlighting and diagnostics disabled for
          responsiveness.
        </div>
      ) : null}
    </>
  );

  let stateSlot: ReactNode = null;
  if (status === "missing") {
    stateSlot = (
      <div className="wb-editor-state" data-testid="wb-editor-missing">
        <strong>File not found</strong>
        <p>{path ?? documentId}</p>
      </div>
    );
  } else if (status === "error") {
    stateSlot = (
      <div className="wb-editor-state" role="alert" data-testid="wb-editor-error">
        <strong>Unable to open document</strong>
        <p>{activeFailure?.error}</p>
      </div>
    );
  }

  return (
    <CodeEditorSurface
      {...common}
      includeMergeConflict={includeMergeConflict}
      attachment={attachment}
      documentIdAttr={documentId}
      languageIdAttr={resolvedLanguageId}
      analysisAllowed={analysisAllowed}
      status={status}
      active={active}
      readOnly={effectiveReadOnly}
      inputLabel={path ? `Editor: ${path}` : "Editor input"}
      focusDecision={focusDecision}
      focusSeq={focusSeq}
      onChange={(state, editor) => {
        emitCursor(state.cursor);
        onChange?.(state, editor);
      }}
      onScroll={(position) => emitScroll(documentId, position)}
      onContainerKeyDown={handleContainerKeyDown}
      bannerSlot={bannerSlot}
      stateSlot={stateSlot}
    />
  );
}

/**
 * Unified React 19 Singapore code editor supporting both adapter-backed documents
 * (shared live `EditorTextBuffer` + per-pane `EditorViewSession`) and caller-owned live
 * `EditorBufferSession` attachments.
 */
export function CodeEditor(props: CodeEditorProps) {
  if (isAdapterProps(props)) {
    return <AdapterCodeEditor {...props} />;
  }
  return <SessionCodeEditor {...props} />;
}
