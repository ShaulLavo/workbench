import { useState, type DragEvent, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import type { GitStatusCode } from "../../core/index";
import { FileTypeIcon, StrokeIcon } from "../../icons/react";
import { cx, InlineRenameInput } from "../../ui/index";
import type { TreeDraftRow, TreeEntryRow, TreeStatusRow } from "../tree-model";
import { entryNameProblemMessage, renameSelection, splitFilename, validateEntryName } from "../paths";

const GIT_BADGE_LETTER: Readonly<Record<GitStatusCode, string>> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
  ignored: "I",
  conflict: "!",
};

export interface FileTreeRowProps {
  readonly row: TreeEntryRow;
  readonly activeParentPath: string | undefined;
  readonly dropTargetDirectory: string | undefined;
  readonly dropTargetSegment: string | undefined;
  readonly canDrag: boolean;
  readonly siblingNames: ReadonlySet<string>;
  readonly isTabStop: boolean;
  readonly active?: boolean;
  readonly loading?: boolean;
  readonly decoration?: ReactNode;
  readonly focusSeq?: number;
  readonly onFocusHandled?: (seq: number) => void;
  readonly onRowElementChange?: (path: string, element: HTMLElement | null) => void;
  readonly onRowFocus?: (row: TreeEntryRow) => void;
  readonly onActivate: (row: TreeEntryRow, event: MouseEvent<HTMLElement>) => void;
  readonly onDoubleClickRename?: (row: TreeEntryRow, targetPath?: string) => void;
  readonly onToggleDirectory: (dirPath: string) => void;
  readonly onSegmentClick: (
    row: TreeEntryRow,
    segmentPath: string,
    event: MouseEvent<HTMLButtonElement>,
  ) => void;
  readonly onContextMenu: (row: TreeEntryRow, event: MouseEvent<HTMLElement>) => void;
  readonly onCommitRename: (fromPath: string, nextName: string) => void;
  readonly onCancelDraft: () => void;
  readonly onHoverPrefetch?: (path: string) => void;
  readonly onRowDragStart?: (row: TreeEntryRow, event: DragEvent<HTMLElement>) => void;
  readonly onRowDragOver?: (
    row: TreeEntryRow,
    segmentPath: string | undefined,
    event: DragEvent<HTMLElement>,
  ) => void;
  readonly onRowDrop?: (
    row: TreeEntryRow,
    segmentPath: string | undefined,
    event: DragEvent<HTMLElement>,
  ) => void;
  readonly onRowDragEnd?: () => void;
  readonly onTouchPointerDown?: (row: TreeEntryRow, event: PointerEvent<HTMLElement>) => void;
  readonly onTouchPointerMove?: (event: PointerEvent<HTMLElement>) => void;
  readonly onTouchPointerUp?: (event: PointerEvent<HTMLElement>) => void;
  readonly onTouchPointerCancel?: () => void;
}

/** Renders one virtualized file or folder row with indent guides, compact segments, git status, and inline rename. */
export function FileTreeRow({
  row,
  activeParentPath,
  dropTargetDirectory,
  dropTargetSegment,
  canDrag,
  siblingNames,
  isTabStop,
  active = false,
  loading = false,
  decoration,
  focusSeq,
  onFocusHandled,
  onRowElementChange,
  onRowFocus,
  onActivate,
  onDoubleClickRename,
  onToggleDirectory,
  onSegmentClick,
  onContextMenu,
  onCommitRename,
  onCancelDraft,
  onHoverPrefetch,
  onRowDragStart,
  onRowDragOver,
  onRowDrop,
  onRowDragEnd,
  onTouchPointerDown,
  onTouchPointerMove,
  onTouchPointerUp,
  onTouchPointerCancel,
}: FileTreeRowProps) {
  const isDirectory = row.kind === "directory";
  const isDropHighlight = isDirectory && dropTargetSegment === undefined && dropTargetDirectory === row.path;
  const split = isDirectory ? null : splitFilename(row.name);
  const accessibleName =
    row.segments && row.segments.length > 1 ? row.segments.map((seg) => seg.name).join("/") : row.name;
  const gitLetter =
    row.gitStatus && row.gitStatus !== "ignored" ? GIT_BADGE_LETTER[row.gitStatus] : undefined;

  return (
    <div
      ref={(el) => {
        onRowElementChange?.(row.path, el);
        if (el && focusSeq !== undefined) {
          el.focus();
          onFocusHandled?.(focusSeq);
        }
        return () => {
          onRowElementChange?.(row.path, null);
        };
      }}
      role="treeitem"
      aria-label={accessibleName}
      aria-level={row.depth + 1}
      aria-selected={row.selected}
      aria-current={active ? "true" : undefined}
      aria-expanded={isDirectory ? row.expanded : undefined}
      tabIndex={isTabStop ? 0 : -1}
      draggable={canDrag && !row.editing}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onRowFocus?.(row);
      }}
      data-wb-tree-row=""
      data-path={row.path}
      data-kind={row.kind}
      data-selected={row.selected ? "true" : "false"}
      data-active={active ? "true" : undefined}
      data-loading={loading ? "true" : undefined}
      data-selection-edge={row.selectionEdge}
      data-focused={row.focused ? "true" : "false"}
      data-ignored={row.ignored ? "true" : undefined}
      data-context-only={row.contextOnly ? "true" : undefined}
      data-drop-target={isDropHighlight ? "true" : undefined}
      data-testid={`wb-tree-row-${row.path}`}
      title={row.path}
      className={cx("wb-tree-row", row.gitStatus && `wb-tree-git-${row.gitStatus}`)}
      style={{ paddingLeft: `calc(${row.depth} * var(--wb-tree-indent) + 0.375rem)` }}
      onClick={(event) => {
        if (row.editing) return;
        onActivate(row, event);
      }}
      onDoubleClick={() => {
        if (row.editing || !onDoubleClickRename) return;
        if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches) return;
        onDoubleClickRename(row);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(row, event);
      }}
      onPointerEnter={() => {
        if (row.kind === "file") onHoverPrefetch?.(row.path);
      }}
      onPointerDown={(event) => onTouchPointerDown?.(row, event)}
      onPointerMove={onTouchPointerMove}
      onPointerUp={onTouchPointerUp}
      onPointerCancel={onTouchPointerCancel}
      onDragStart={(event) => onRowDragStart?.(row, event)}
      onDragOver={(event) => onRowDragOver?.(row, undefined, event)}
      onDrop={(event) => onRowDrop?.(row, undefined, event)}
      onDragEnd={onRowDragEnd}
    >
      {row.depth > 0 ? (
        <span className="wb-tree-guides" aria-hidden="true">
          {row.ancestorPaths.map((ancPath, level) => (
            <span
              key={ancPath}
              className="wb-tree-guide"
              data-guide-level={level}
              data-active-guide={activeParentPath === ancPath ? "true" : undefined}
              style={{ left: `calc(${level} * var(--wb-tree-indent) + 0.75rem)` }}
            />
          ))}
        </span>
      ) : null}

      <span
        className="wb-tree-chevron"
        data-expanded={isDirectory && row.expanded ? "true" : undefined}
        aria-hidden="true"
        onClick={(event) => {
          if (!isDirectory) return;
          event.stopPropagation();
          onToggleDirectory(row.path);
        }}
      >
        {isDirectory ? (
          row.loading ? (
            <span className="wb-tree-spinner" />
          ) : (
            <StrokeIcon name="chevron" />
          )
        ) : null}
      </span>

      <FileTypeIcon entry={{ name: row.name, type: row.kind }} open={row.expanded} sprite />

      {row.editing ? (
        <RenameField
          initialValue={row.name}
          siblingNames={siblingNames}
          onCommit={(nextName) => onCommitRename(row.path, nextName)}
          onCancel={onCancelDraft}
        />
      ) : row.segments && row.segments.length > 1 ? (
        <span className="wb-tree-segments">
          {row.segments.map((seg, idx) => (
            <span key={seg.path} className="wb-tree-segment-wrap">
              {idx > 0 ? (
                <span className="wb-tree-segment-sep" aria-hidden="true">
                  /
                </span>
              ) : null}
              <button
                type="button"
                tabIndex={-1}
                className="wb-tree-segment"
                data-wb-drop-segment={seg.path}
                data-drop-active={dropTargetSegment === seg.path ? "true" : undefined}
                data-testid={`wb-tree-segment-${seg.path}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSegmentClick(row, seg.path, event);
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  if (!onDoubleClickRename) return;
                  if (typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches) {
                    return;
                  }
                  onDoubleClickRename(row, seg.path);
                }}
                onDragOver={(event) => {
                  event.stopPropagation();
                  onRowDragOver?.(row, seg.path, event);
                }}
                onDrop={(event) => {
                  event.stopPropagation();
                  onRowDrop?.(row, seg.path, event);
                }}
              >
                {seg.name}
              </button>
            </span>
          ))}
        </span>
      ) : split ? (
        <span className="wb-tree-name">
          <span className="wb-tree-stem">{split.stem}</span>
          {split.ext ? <span className="wb-tree-ext">{split.ext}</span> : null}
        </span>
      ) : (
        <span className="wb-tree-name">
          <span className="wb-tree-stem">{row.name}</span>
        </span>
      )}

      {decoration ? (
        <span className="wb-tree-decoration" data-wb-tree-decoration="">
          {decoration}
        </span>
      ) : null}

      {gitLetter ? (
        <span className="wb-tree-git-badge" data-status={row.gitStatus} aria-label={`Git ${row.gitStatus}`}>
          {gitLetter}
        </span>
      ) : row.hasChangedDescendant ? (
        <span className="wb-tree-git-dot" data-wb-git-dot="true" aria-label="Contains Git changes" />
      ) : null}
    </div>
  );
}

function RenameField({
  initialValue,
  siblingNames,
  onCommit,
  onCancel,
}: {
  readonly initialValue: string;
  readonly siblingNames: ReadonlySet<string>;
  readonly onCommit: (nextName: string) => void;
  readonly onCancel: () => void;
}) {
  const selection = initialValue ? renameSelection(initialValue) : ([0, 0] as const);
  return (
    <ValidatingInlineInput
      initialValue={initialValue}
      initialSelection={selection}
      siblingNames={siblingNames}
      currentName={initialValue}
      ariaLabel={`Rename ${initialValue}`}
      onCommit={onCommit}
      onCancel={onCancel}
    />
  );
}

export interface FileTreeDraftRowProps {
  readonly row: TreeDraftRow;
  readonly siblingNames: ReadonlySet<string>;
  readonly onCommit: (parent: string, kind: "file" | "directory", name: string) => void;
  readonly onCancel: () => void;
}

export function FileTreeDraftRow({ row, siblingNames, onCommit, onCancel }: FileTreeDraftRowProps) {
  return (
    <div
      data-wb-tree-draft=""
      className="wb-tree-row wb-tree-row-draft"
      style={{ paddingLeft: `calc(${row.depth} * var(--wb-tree-indent) + 0.375rem)` }}
    >
      <span className="wb-tree-chevron" aria-hidden="true" />
      <FileTypeIcon entry={{ name: "", type: row.kind }} sprite />
      <ValidatingInlineInput
        initialValue=""
        siblingNames={siblingNames}
        ariaLabel={row.kind === "directory" ? "New folder name" : "New file name"}
        onCommit={(name) => onCommit(row.parent, row.kind, name)}
        onCancel={onCancel}
      />
    </div>
  );
}

function ValidatingInlineInput({
  initialValue,
  initialSelection,
  siblingNames,
  currentName,
  ariaLabel,
  onCommit,
  onCancel,
}: {
  readonly initialValue: string;
  readonly initialSelection?: readonly [number, number];
  readonly siblingNames: ReadonlySet<string>;
  readonly currentName?: string;
  readonly ariaLabel: string;
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
}) {
  const [draftValue, setDraftValue] = useState(initialValue);
  const problem = validateEntryName(draftValue, siblingNames, currentName);
  const validationMessage =
    draftValue === initialValue && initialValue === "" ? undefined : entryNameProblemMessage(problem);

  return (
    <InlineRenameInput
      aria-label={ariaLabel}
      initialValue={initialValue}
      initialSelection={initialSelection}
      validationMessage={validationMessage}
      data-testid="wb-tree-inline-input"
      onValueChange={setDraftValue}
      onCommit={(value) => {
        const trimmed = value.trim();
        if (!trimmed || validateEntryName(trimmed, siblingNames, currentName)) {
          onCancel();
          return;
        }
        onCommit(trimmed);
      }}
      onCancel={onCancel}
    />
  );
}

export interface FileTreeStatusRowProps {
  readonly row: TreeStatusRow;
  readonly onRetry?: (dirPath: string) => void;
}

export function FileTreeStatusRow({ row, onRetry }: FileTreeStatusRowProps) {
  return (
    <div
      data-wb-tree-status={row.type}
      className={cx("wb-tree-row wb-tree-row-status", row.type === "error" && "wb-tree-row-error")}
      style={{ paddingLeft: `calc(${row.depth} * var(--wb-tree-indent) + 1.5rem)` }}
      role={row.type === "error" ? "alert" : "status"}
    >
      {row.type === "loading" ? <span className="wb-tree-spinner" aria-hidden="true" /> : null}
      <span className="wb-tree-status-text">{row.message}</span>
      {row.type === "error" && row.retryable && onRetry ? (
        <button
          type="button"
          className="wb-tree-retry-btn"
          data-testid={`wb-tree-retry-${row.directory || "root"}`}
          onClick={() => onRetry(row.directory)}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
