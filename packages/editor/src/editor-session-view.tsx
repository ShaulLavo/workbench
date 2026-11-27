import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type FocusEventHandler,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { observeWorkbenchTheme, type ThemeVersionSource } from "@shaulavo/workbench-tokens";
import { cx } from "@shaulavo/workbench-ui";
import type { EditorBufferSession } from "@singapore-editor/core/document";
import type { Editor, EditorOptions, EditorScrollPosition, EditorState } from "@singapore-editor/core/editor";
import type { EditorPlugin } from "@singapore-editor/core/extensions";
import type { EditorTheme } from "@singapore-editor/core/rendering";
import type { FoldGutterIcon } from "@singapore-editor/gutters/fold-gutter";
import type { HighlightingService, HighlightingThemeSource } from "@singapore-editor/highlighting";
import { useEditor } from "@singapore-editor/react";
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

export interface EditorSessionViewProps {
  /** Currently attached session, or `null` when no file is open (detaches without unmounting the editor). */
  readonly attachment: EditorSessionAttachment | null;
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
  readonly useDefaultHighlighting?: boolean;
  readonly highlightingService?: HighlightingService | null;
  readonly highlightingTheme?: HighlightingThemeSource;
  readonly foldIcons?: {
    readonly expandedIcon?: FoldGutterIcon;
    readonly collapsedIcon?: FoldGutterIcon;
  };
  readonly includeMergeConflict?: boolean;
  readonly extraPlugins?: readonly EditorPlugin[];
  readonly reveal?: EditorRevealTarget | null;
  readonly onBeforeDetach?: (
    attachment: EditorSessionAttachment,
    scrollPosition: EditorScrollPosition,
  ) => void;
  readonly onAttached?: (editor: Editor, attachment: EditorSessionAttachment) => void;
  readonly onDetached?: (editor: Editor) => void;
  readonly onEditorReady?: (editor: Editor | null) => void;
  readonly onChange?: (state: EditorState, editor: Editor) => void;
  readonly onBlur?: FocusEventHandler<HTMLDivElement>;
  readonly onContextMenu?: MouseEventHandler<HTMLDivElement>;
  readonly onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  readonly emptyState?: ReactNode;
  readonly className?: string;
  readonly hostClassName?: string;
  readonly hostTestId?: string;
}

function readNarrowViewport(): boolean {
  return typeof matchMedia === "function" && matchMedia("(max-width: 768px)").matches;
}

function computeRevealOffset(session: EditorBufferSession, line: number, column: number | undefined): number {
  const snapshot = session.getTextSnapshot();
  const row = Math.max(0, Math.min(line - 1, snapshot.lineCount - 1));
  const range = snapshot.lineRange(row);
  return Math.min(range.start + Math.max(0, (column ?? 1) - 1), range.end);
}

/**
 * Persistent single-instance Singapore editor view for hosts that own live `EditorBufferSession`
 * objects per tab (preserving undo history, carets, and scroll across tab switches and empty states).
 */
export function EditorSessionView({
  attachment,
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
  useDefaultHighlighting = true,
  highlightingService,
  highlightingTheme,
  foldIcons,
  includeMergeConflict = false,
  extraPlugins,
  reveal,
  onBeforeDetach,
  onAttached,
  onDetached,
  onEditorReady,
  onChange,
  onBlur,
  onContextMenu,
  onKeyDown,
  emptyState,
  className,
  hostClassName,
  hostTestId = "wb-editor-surface",
}: EditorSessionViewProps) {
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);
  const hostElRef = useRef<HTMLDivElement | null>(null);
  const [detectedNarrow, setDetectedNarrow] = useState<boolean>(() => readNarrowViewport());
  const [tokenTheme, setTokenTheme] = useState<EditorTheme>(() => buildWorkbenchEditorTheme(null));
  const attachedRef = useRef<EditorSessionAttachment | null>(null);
  const handledRevealRef = useRef<number>(0);

  const narrow = narrowProp ?? detectedNarrow;
  const theme = themeOverride ?? tokenTheme;

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

  // Created once per mount so Singapore does not tear down and recreate its plugin stack on renders.
  const [plugins] = useState(() =>
    createWorkbenchEditorPlugins({
      analysisAllowed: true,
      narrowViewport: narrow,
      useDefaultHighlighting,
      highlightingService,
      highlightingTheme,
      foldIcons,
      includeMergeConflict,
      extraPlugins,
    }),
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
    storeSync: "none",
    onChange(state) {
      const instance = controller.getEditor();
      if (instance) emitChange(state, instance);
    },
  });
  const { ref: editorMountRef } = controller;
  const editor = controller.useEditorInstance();

  useEffect(() => {
    if (!hostEl) return;
    let active = true;
    const syncTheme = (): void => {
      if (!active) return;
      setTokenTheme(buildWorkbenchEditorTheme(hostEl));
    };
    const stopTheme = themeOverride ? undefined : observeWorkbenchTheme(hostEl, syncTheme, { themeVersion });
    if (!themeOverride) queueMicrotask(syncTheme);
    if (narrowProp !== undefined || typeof matchMedia !== "function") {
      return () => {
        active = false;
        stopTheme?.();
      };
    }
    const media = matchMedia("(max-width: 768px)");
    const onMedia = (): void => setDetectedNarrow(media.matches);
    media.addEventListener("change", onMedia);
    return () => {
      active = false;
      stopTheme?.();
      media.removeEventListener("change", onMedia);
    };
  }, [hostEl, narrowProp, themeOverride, themeVersion]);

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

  useEffect(() => {
    emitEditorReady(editor);
    return () => {
      emitEditorReady(null);
    };
  }, [editor]);

  // Attach or detach the active buffer session while preserving scroll across switches.
  useEffect(() => {
    if (!editor) return;
    const current = attachedRef.current;

    if (!attachment) {
      if (!current) return;
      emitBeforeDetach(current, editor.getScrollPosition());
      editor.detachSession();
      attachedRef.current = null;
      emitDetached(editor);
      return;
    }

    const sameSession =
      current?.session === attachment.session &&
      current.documentId === attachment.documentId &&
      current.languageId === attachment.languageId;
    if (sameSession) return;

    if (current) {
      emitBeforeDetach(current, editor.getScrollPosition());
    }

    const savedScroll = attachment.scrollPosition;
    editor.attachSession(attachment.session, {
      documentId: attachment.documentId,
      languageId: attachment.languageId ?? null,
      scrollPosition: savedScroll,
    });
    if (savedScroll?.top !== undefined) {
      const hostHeight = hostElRef.current?.clientHeight ?? 0;
      const clamped = clampRestoredScroll(savedScroll, editor.getContentHeight(), hostHeight);
      if (clamped && clamped.top !== editor.getScrollPosition().top) {
        editor.setScrollPosition(clamped);
      }
    }
    attachedRef.current = attachment;
    emitAttached(editor, attachment);
  }, [editor, attachment]);

  // Apply reveal requests (jump to 1-based line/column and optional focus) once per monotonic seq.
  useEffect(() => {
    if (!editor || !reveal || !attachedRef.current) return;
    if (reveal.seq === handledRevealRef.current) return;
    handledRevealRef.current = reveal.seq;
    if (reveal.line !== undefined) {
      const offset = computeRevealOffset(attachedRef.current.session, reveal.line, reveal.column);
      editor.jumpTo(offset, undefined, "go-to-line");
    }
    if (reveal.focus) editor.focus();
  }, [editor, reveal, attachment]);

  const attachHostRef = (element: HTMLDivElement | null) => {
    hostElRef.current = element;
    setHostEl(element);
    return editorMountRef(element);
  };

  return (
    <div
      data-wb-editor=""
      data-document-id={attachment?.documentId ?? undefined}
      data-language-id={attachment?.languageId ?? "plain"}
      data-readonly={readOnly ? "true" : "false"}
      data-status={attachment ? "ready" : "empty"}
      className={cx("wb-editor-view", className)}
    >
      <div
        ref={attachHostRef}
        className={cx("wb-editor-surface", hostClassName)}
        data-testid={hostTestId}
        onBlur={onBlur}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      />
      {!attachment ? emptyState : null}
    </div>
  );
}
