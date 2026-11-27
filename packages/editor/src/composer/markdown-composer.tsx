import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type Ref,
} from "react";
import { observeWorkbenchTheme, type ThemeVersionSource } from "@shaulavo/workbench-tokens";
import { cx } from "@shaulavo/workbench-ui";
import type { EditorPlugin } from "@singapore-editor/core/extensions";
import type { EditorTheme } from "@singapore-editor/core/rendering";
import { createMarkdownAuthoringPlugin, createMarkdownPreviewPlugin } from "@singapore-editor/markdown";
import { useEditor } from "@singapore-editor/react";
import { buildWorkbenchEditorTheme } from "../utils/theme";
import {
  createMentionInlineReplacementPlugin,
  findMentionRanges,
  findTriggerAtCursor,
  formatMentionToken,
  type ComposerMentionItem,
  type ComposerSlashCommand,
  type ComposerTriggerMatch,
} from "./mentions";

export type ComposerPresentationMode = "source" | "reveal" | "visual";

export interface MarkdownComposerSubmitPayload {
  readonly text: string;
  readonly mentions: readonly string[];
}

export interface MarkdownComposerHandle {
  focus(): void;
  clear(): void;
  getText(): string;
  setText(text: string): void;
  insertMention(filePath: string): void;
}

export interface MarkdownComposerProps {
  readonly ref?: Ref<MarkdownComposerHandle>;
  readonly defaultValue?: string;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  readonly maxHeightPx?: number;
  readonly presentation?: ComposerPresentationMode;
  readonly themeVersion?: ThemeVersionSource;
  readonly mentionItems?: readonly ComposerMentionItem[];
  readonly slashCommands?: readonly ComposerSlashCommand[];
  readonly promptHistory?: readonly string[];
  readonly onChange?: (text: string) => void;
  readonly onSubmit?: (payload: MarkdownComposerSubmitPayload) => void;
  readonly onSelectCommand?: (command: ComposerSlashCommand) => void;
  readonly onPasteFiles?: (files: readonly File[]) => void;
  readonly onDropPaths?: (paths: readonly string[]) => void;
  readonly className?: string;
}

const COMPOSER_SURROUND_PAIRS = [
  { open: "`", close: "`" },
  { open: "*", close: "*" },
  { open: "_", close: "_" },
  { open: "[", close: "]" },
  { open: "(", close: ")" },
] as const;

function parseDroppedPaths(dataTransfer: DataTransfer): readonly string[] {
  const custom = dataTransfer.getData("application/x-workbench-paths");
  if (custom) {
    try {
      const parsed = JSON.parse(custom) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
      }
    } catch {
      // Fall through to plain text parsing below.
    }
  }
  const plain = dataTransfer.getData("text/plain").trim();
  if (!plain) return [];
  if (plain.includes("/") || /^[^/\s]+\.[A-Za-z][A-Za-z0-9_-]{0,9}$/.test(plain)) {
    return [plain];
  }
  return [];
}

/**
 * Singapore-powered Markdown prompt composer with native atomic `@file` mention chips
 * (`reveal: "never"`, `atomic: true`), `/` slash command popup, paste/drop routing, auto-grow
 * height cap, placeholder, IME-safe Enter submit, prompt history, and configurable `aria-label`.
 */
export function MarkdownComposer({
  ref,
  defaultValue = "",
  placeholder = "Ask anything… Type @ for files or / for commands",
  ariaLabel = "Message",
  disabled = false,
  maxHeightPx = 180,
  presentation = "reveal",
  themeVersion,
  mentionItems = [],
  slashCommands = [],
  promptHistory = [],
  onChange,
  onSubmit,
  onSelectCommand,
  onPasteFiles,
  onDropPaths,
  className,
}: MarkdownComposerProps) {
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);
  const [theme, setTheme] = useState<EditorTheme>(() => buildWorkbenchEditorTheme(null));
  const [textValue, setTextValue] = useState(defaultValue);
  const [trigger, setTrigger] = useState<ComposerTriggerMatch | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  const historyIndexRef = useRef(-1);
  const draftBeforeHistoryRef = useRef("");

  const knownPaths = useMemo(
    () => (mentionItems.length > 0 ? new Set(mentionItems.map((item) => item.path)) : undefined),
    [mentionItems],
  );

  const emitChange = useEffectEvent((text: string) => {
    onChange?.(text);
  });

  useEffect(() => {
    if (!hostEl) return;
    const sync = (): void => setTheme(buildWorkbenchEditorTheme(hostEl));
    sync();
    return observeWorkbenchTheme(hostEl, sync, { themeVersion });
  }, [hostEl, themeVersion]);

  const plugins = useMemo<readonly EditorPlugin[]>(() => {
    const base: EditorPlugin[] = [
      createMentionInlineReplacementPlugin({
        getKnownPaths: () => knownPaths,
      }),
      createMarkdownAuthoringPlugin(),
    ];
    if (presentation !== "source") {
      base.push(createMarkdownPreviewPlugin({ languageIds: ["markdown"] }));
    }
    return base;
  }, [knownPaths, presentation]);

  const documentSpec = useMemo(
    () => ({
      documentId: "wb-markdown-composer",
      defaultText: defaultValue,
      languageId: "markdown" as const,
    }),
    [defaultValue],
  );

  const controller = useEditor({
    document: documentSpec,
    editability: disabled ? "readonly" : "editable",
    theme,
    plugins,
    height: "content",
    maxHeight: maxHeightPx,
    scrollPastEnd: false,
    cursorLineHighlight: {
      rowBackground: false,
      gutterBackground: false,
      gutterNumber: false,
    },
    wordWrap: true,
    wordWrapBreak: "word",
    inputKind: "prose",
    inputLabel: ariaLabel,
    tabMovesFocus: true,
    autoClosingPairs: [],
    surroundingPairs: COMPOSER_SURROUND_PAIRS,
    fontSize: 13,
    lineHeight: 20,
    onChange(state) {
      const nextText = controller.materializeFullText();
      setTextValue(nextText);
      emitChange(nextText);
      const snap = controller.getTextSnapshot();
      const caretOffset = snap
        ? Math.min(nextText.length, snap.lineStart(state.cursor.row) + state.cursor.column)
        : nextText.length;
      const nextTrigger = findTriggerAtCursor(nextText, caretOffset);
      setTrigger(nextTrigger);
      setHighlightedIndex(0);
    },
  });

  const { ref: editorMountRef, commands } = controller;

  const filteredMentions = useMemo(() => {
    if (trigger?.kind !== "mention") return [];
    const q = trigger.query.toLowerCase();
    return mentionItems
      .filter((item) => item.path.toLowerCase().includes(q) || (item.label ?? "").toLowerCase().includes(q))
      .slice(0, 8);
  }, [mentionItems, trigger]);

  const filteredCommands = useMemo(() => {
    if (trigger?.kind !== "slash") return [];
    const q = trigger.query.toLowerCase();
    return slashCommands
      .filter(
        (cmd) => cmd.name.toLowerCase().includes(q) || (cmd.description ?? "").toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [slashCommands, trigger]);

  let activeItemsCount = 0;
  if (trigger?.kind === "mention") {
    activeItemsCount = filteredMentions.length;
  } else if (trigger?.kind === "slash") {
    activeItemsCount = filteredCommands.length;
  }
  const popupOpen = trigger !== null && activeItemsCount > 0;
  const safeHighlight = activeItemsCount > 0 ? Math.min(highlightedIndex, activeItemsCount - 1) : 0;

  function applyMentionInsert(
    filePath: string,
    replaceRange?: { readonly start: number; readonly end: number },
  ): void {
    const token = formatMentionToken(filePath);
    if (!token) return;
    const current = controller.materializeFullText();
    if (replaceRange) {
      const insertion = `${token} `;
      commands.edit(
        { from: replaceRange.start, to: replaceRange.end, text: insertion },
        { selection: { anchor: replaceRange.start + insertion.length } },
      );
    } else {
      const prefix = current.length > 0 && !/\s$/.test(current) ? " " : "";
      const insertion = `${prefix}${token} `;
      commands.edit(
        { from: current.length, to: current.length, text: insertion },
        { selection: { anchor: current.length + insertion.length } },
      );
    }
    setTrigger(null);
    commands.focus();
  }

  function applySlashCommand(command: ComposerSlashCommand): void {
    if (trigger) {
      const replacement = command.insertText ?? "";
      commands.edit(
        { from: trigger.start, to: trigger.end, text: replacement },
        { selection: { anchor: trigger.start + replacement.length } },
      );
    }
    setTrigger(null);
    onSelectCommand?.(command);
    commands.focus();
  }

  function submitCurrentPrompt(): void {
    if (disabled) return;
    const current = controller.materializeFullText();
    const trimmed = current.trim();
    if (!trimmed) return;
    const mentions = findMentionRanges(trimmed, knownPaths).map((m) => m.path);
    onSubmit?.({ text: trimmed, mentions });
    commands.setText("");
    setTextValue("");
    setTrigger(null);
    historyIndexRef.current = -1;
    draftBeforeHistoryRef.current = "";
  }

  const insertMentionAction = useEffectEvent((filePath: string) => {
    applyMentionInsert(filePath);
  });

  useImperativeHandle(
    ref,
    () => ({
      focus: () => commands.focus(),
      clear: () => {
        commands.setText("");
        setTextValue("");
        setTrigger(null);
      },
      getText: () => controller.materializeFullText(),
      setText: (next: string) => {
        commands.setText(next);
        setTextValue(next);
      },
      insertMention: (filePath: string) => insertMentionAction(filePath),
    }),
    [commands, controller],
  );

  function handlePopupKeyDown(event: KeyboardEvent<HTMLDivElement>): boolean {
    if (!popupOpen) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      setHighlightedIndex((idx) => (idx + 1) % activeItemsCount);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setHighlightedIndex((idx) => (idx - 1 + activeItemsCount) % activeItemsCount);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setTrigger(null);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      if (trigger?.kind === "mention") {
        const chosen = filteredMentions[safeHighlight];
        if (chosen) applyMentionInsert(chosen.path, { start: trigger.start, end: trigger.end });
      } else if (trigger?.kind === "slash") {
        const chosen = filteredCommands[safeHighlight];
        if (chosen) applySlashCommand(chosen);
      }
      return true;
    }
    return false;
  }

  function handleHistoryKeyDown(event: KeyboardEvent<HTMLDivElement>): boolean {
    if (promptHistory.length === 0) return false;
    const state = controller.getState();
    const text = controller.materializeFullText();
    if (event.key === "ArrowUp" && (!text || (state?.cursor.row === 0 && state.cursor.column === 0))) {
      event.preventDefault();
      if (historyIndexRef.current === -1) {
        draftBeforeHistoryRef.current = text;
        historyIndexRef.current = promptHistory.length - 1;
      } else if (historyIndexRef.current > 0) {
        historyIndexRef.current -= 1;
      }
      const next = promptHistory[historyIndexRef.current] ?? "";
      commands.setText(next);
      commands.setSelection(next.length);
      setTextValue(next);
      return true;
    }
    if (event.key === "ArrowDown" && historyIndexRef.current >= 0) {
      event.preventDefault();
      if (historyIndexRef.current < promptHistory.length - 1) {
        historyIndexRef.current += 1;
        const next = promptHistory[historyIndexRef.current] ?? "";
        commands.setText(next);
        commands.setSelection(next.length);
        setTextValue(next);
      } else {
        historyIndexRef.current = -1;
        const draft = draftBeforeHistoryRef.current;
        commands.setText(draft);
        commands.setSelection(draft.length);
        setTextValue(draft);
      }
      return true;
    }
    return false;
  }

  function handleKeyDownCapture(event: KeyboardEvent<HTMLDivElement>): void {
    // IME composition guard: never submit or intercept popup keys while composing.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (handlePopupKeyDown(event)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      submitCurrentPrompt();
      return;
    }
    handleHistoryKeyDown(event);
  }

  function handlePasteCapture(event: ClipboardEvent<HTMLDivElement>): void {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0 || !onPasteFiles) return;
    event.preventDefault();
    onPasteFiles(files);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragOver(true);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragOver(false);
    const paths = parseDroppedPaths(event.dataTransfer);
    if (paths.length === 0) return;
    for (const filePath of paths) {
      applyMentionInsert(filePath);
    }
    onDropPaths?.(paths);
  }

  return (
    <div
      ref={setHostEl}
      data-wb-composer=""
      data-presentation={presentation}
      data-drag-over={dragOver ? "true" : undefined}
      data-testid="wb-markdown-composer"
      className={cx("wb-composer", className)}
      onKeyDownCapture={handleKeyDownCapture}
      onPasteCapture={handlePasteCapture}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {popupOpen ? (
        <div
          role="listbox"
          aria-label={trigger.kind === "mention" ? "Mention files" : "Slash commands"}
          data-testid={trigger.kind === "mention" ? "wb-composer-mention-menu" : "wb-composer-slash-menu"}
          className="wb-composer-popup"
        >
          {trigger.kind === "mention"
            ? filteredMentions.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={idx === safeHighlight}
                  data-highlighted={idx === safeHighlight ? "true" : undefined}
                  data-testid={`wb-composer-mention-option-${item.id}`}
                  className="wb-composer-popup-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyMentionInsert(item.path, { start: trigger.start, end: trigger.end })}
                >
                  <span className="wb-composer-popup-title">{item.label ?? item.path}</span>
                  <span className="wb-composer-popup-detail">{item.detail ?? item.path}</span>
                </button>
              ))
            : filteredCommands.map((cmd, idx) => (
                <button
                  key={cmd.id}
                  type="button"
                  role="option"
                  aria-selected={idx === safeHighlight}
                  data-highlighted={idx === safeHighlight ? "true" : undefined}
                  data-testid={`wb-composer-slash-option-${cmd.id}`}
                  className="wb-composer-popup-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applySlashCommand(cmd)}
                >
                  <span className="wb-composer-popup-title">/{cmd.name}</span>
                  {cmd.description ? (
                    <span className="wb-composer-popup-detail">{cmd.description}</span>
                  ) : null}
                </button>
              ))}
        </div>
      ) : null}

      <div className="wb-composer-editor-wrap" style={{ maxHeight: `${maxHeightPx}px` }}>
        <div ref={editorMountRef} className="wb-composer-surface" data-testid="wb-composer-surface" />
        {textValue.length === 0 ? (
          <div className="wb-composer-placeholder" aria-hidden="true" data-testid="wb-composer-placeholder">
            {placeholder}
          </div>
        ) : null}
      </div>
    </div>
  );
}
