import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  dismissSoftKeyboardOnTouchActivation,
  resolveActivationFocus,
  type ActivationFocusDecision,
  type FileSystemAdapter,
  type Subscribable,
} from "@shaulavo/workbench-core";
import { useSubscribable } from "@shaulavo/workbench-core/react";
import {
  ConfirmDialog,
  FilterField,
  PointContextMenu,
  type ContextMenuItem,
  type FilterFieldHandle,
} from "@shaulavo/workbench-ui";
import { bindFileSystemAdapter, type BoundFileTreeAdapter } from "../adapter-bridge";
import {
  canMoveInto,
  FileTreeModel,
  navigateTree,
  targetDirectory,
  topLevelPaths,
  type TreeEntryRow,
  type TreeNavigationKey,
} from "../model";
import { baseName, joinPath, parentOf } from "../paths";
import { FileTreeDraftRow, FileTreeRow, FileTreeStatusRow } from "./tree-row";
import { FileTreeViewport } from "./tree-viewport";

const TREE_DRAG_MIME = "application/x-wb-tree-paths";
const HOVER_OPEN_MS = 600;
const TOUCH_DRAG_HOLD_MS = 400;
const TOUCH_DRAG_TOLERANCE_PX = 10;
const ALWAYS_WRITABLE: Subscribable<boolean> = {
  getSnapshot: () => true,
  subscribe: () => () => {},
};

export interface FileTreeViewProps {
  /** Optional external `FileTreeModel` (e.g. from a cached `PreparedFileTreeInput`). */
  readonly model?: FileTreeModel;
  /** Optional `FileSystemAdapter` (lazy or indexed) to bind automatically. */
  readonly adapter?: FileSystemAdapter;
  readonly label?: string;
  readonly iconPreset?: "rich" | "stroke";
  readonly showFilter?: boolean;
  readonly readOnly?: boolean;
  readonly onOpenFile?: (path: string, focus: ActivationFocusDecision) => void;
  readonly onError?: (message: string, error: unknown) => void;
  readonly extraContextMenuItems?: (row: TreeEntryRow) => readonly ContextMenuItem[];
  readonly className?: string;
}

function isNavKey(key: string): key is TreeNavigationKey {
  return (
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "Home" ||
    key === "End"
  );
}

function isFilterSeedKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
  return event.key.length === 1 && event.key !== " ";
}

/**
 * Clean-room MIT virtualized file tree component supporting indexed 50k-path snapshots/patches,
 * lazy per-directory loading/retry, compact folder chains with per-segment drop targets, inline
 * type-to-filter, sticky ancestors, IME-safe create/rename, multi-select pills, keyboard nav,
 * drag-and-drop with edge auto-scroll, touch long-press drag, and per-activation touch focus.
 */
export function FileTreeView({
  model: externalModel,
  adapter,
  label = "File explorer",
  iconPreset = "rich",
  showFilter = true,
  readOnly = false,
  onOpenFile,
  onError,
  extraContextMenuItems,
  className,
}: FileTreeViewProps) {
  const [internalModel] = useState(() => new FileTreeModel());
  const model = externalModel ?? internalModel;
  const state = useSubscribable(model);

  const boundRef = useRef<BoundFileTreeAdapter | null>(null);
  const filterRef = useRef<FilterFieldHandle | null>(null);
  const hoverOpenTimerRef = useRef<number | undefined>(undefined);
  const hoverOpenDirRef = useRef<string | undefined>(undefined);
  const optimisticSeqRef = useRef(0);
  const touchDragRef = useRef<{
    timer: number | undefined;
    pointerId: number;
    startX: number;
    startY: number;
    rowPath: string;
    element: HTMLElement;
  } | null>(null);

  const [filterVisible, setFilterVisible] = useState(showFilter);
  const [draggingPaths, setDraggingPaths] = useState<readonly string[]>([]);
  const [dropTarget, setDropTarget] = useState<{
    readonly directory: string;
    readonly segmentPath?: string;
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    readonly open: boolean;
    readonly x: number;
    readonly y: number;
    readonly row: TreeEntryRow | null;
  }>({ open: false, x: 0, y: 0, row: null });
  const [deleteTarget, setDeleteTarget] = useState<readonly string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [focusRequest, setFocusRequest] = useState<{ readonly path: string; readonly seq: number } | null>(
    null,
  );
  const [scrollSeq, setScrollSeq] = useState(0);
  const focusSeqRef = useRef(0);

  const adapterWritable = useSubscribable(adapter?.writable ?? ALWAYS_WRITABLE);
  const writable = !readOnly && adapterWritable;

  function requestRowFocus(path: string): void {
    focusSeqRef.current += 1;
    const seq = focusSeqRef.current;
    setScrollSeq(seq);
    setFocusRequest({ path, seq });
  }

  function handleFocusHandled(seq: number): void {
    setFocusRequest((current) => (current && current.seq === seq ? null : current));
  }

  useEffect(() => {
    if (!adapter) {
      boundRef.current = null;
      return;
    }
    const bound = bindFileSystemAdapter(model, adapter);
    boundRef.current = bound;
    return () => {
      bound.dispose();
      boundRef.current = null;
    };
  }, [model, adapter]);

  useEffect(() => {
    return () => {
      if (hoverOpenTimerRef.current !== undefined) window.clearTimeout(hoverOpenTimerRef.current);
      if (touchDragRef.current?.timer !== undefined) window.clearTimeout(touchDragRef.current.timer);
    };
  }, []);

  function clearHoverOpen(): void {
    if (hoverOpenTimerRef.current !== undefined) {
      window.clearTimeout(hoverOpenTimerRef.current);
      hoverOpenTimerRef.current = undefined;
    }
    hoverOpenDirRef.current = undefined;
  }

  function scheduleHoverOpen(dirPath: string): void {
    if (hoverOpenDirRef.current === dirPath) return;
    clearHoverOpen();
    if (state.expanded.has(dirPath)) return;
    hoverOpenDirRef.current = dirPath;
    hoverOpenTimerRef.current = window.setTimeout(() => {
      hoverOpenTimerRef.current = undefined;
      model.setExpanded(dirPath, true);
      void boundRef.current?.ensureDirectoryLoaded(dirPath);
    }, HOVER_OPEN_MS);
  }

  function nextOptimisticId(): string {
    optimisticSeqRef.current += 1;
    return `wb-opt-${optimisticSeqRef.current}`;
  }

  function toggleDirectory(dirPath: string): void {
    const opened = model.toggleExpanded(dirPath);
    if (opened) void boundRef.current?.ensureDirectoryLoaded(dirPath);
  }

  function handleActivateRow(row: TreeEntryRow, event: MouseEvent<HTMLElement>): void {
    if (event.shiftKey) {
      model.select(row.path, "range", "pointer");
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      model.select(row.path, "toggle", "pointer");
      return;
    }
    model.select(row.path, "replace", "pointer");
    if (row.kind === "directory") {
      toggleDirectory(row.path);
      return;
    }
    const decision = resolveActivationFocus(event, "auto");
    if (!decision.shouldFocusEditor) {
      dismissSoftKeyboardOnTouchActivation(decision, event.currentTarget);
    }
    onOpenFile?.(row.path, decision);
  }

  function handleSegmentClick(segmentPath: string, event: MouseEvent<HTMLButtonElement>): void {
    model.select(segmentPath, "replace", "pointer");
    if (event.detail >= 2) {
      toggleDirectory(segmentPath);
    }
  }

  async function commitCreate(parent: string, kind: "file" | "directory", name: string): Promise<void> {
    const fullPath = joinPath(parent, name);
    model.setDraft(undefined);
    const optId = nextOptimisticId();
    model.index.applyOptimistic(optId, { kind: "create", path: fullPath, entryKind: kind });
    model.notifyIndexChange();
    model.select(fullPath, "replace", "keyboard");
    requestRowFocus(fullPath);
    if (!adapter) return;
    try {
      if (kind === "directory") await adapter.createDirectory(fullPath);
      else await adapter.createFile(fullPath, "");
    } catch (error) {
      model.index.rollbackOptimistic(optId);
      model.notifyIndexChange();
      onError?.(`Unable to create ${name}`, error);
    }
  }

  async function commitRename(fromPath: string, nextName: string): Promise<void> {
    const toPath = joinPath(parentOf(fromPath), nextName);
    model.setDraft(undefined);
    if (toPath === fromPath) {
      requestRowFocus(fromPath);
      return;
    }
    const entryKind = model.index.getKind(fromPath) ?? "file";
    const optId = nextOptimisticId();
    model.index.applyOptimistic(optId, {
      kind: "move",
      moves: [{ from: fromPath, to: toPath, entryKind }],
    });
    model.notifyIndexChange();
    model.select(toPath, "replace", "keyboard");
    requestRowFocus(toPath);
    if (!adapter) return;
    try {
      await adapter.move(fromPath, toPath);
    } catch (error) {
      model.index.rollbackOptimistic(optId);
      model.notifyIndexChange();
      onError?.(`Unable to rename ${baseName(fromPath)}`, error);
    }
  }

  async function executeMove(sources: readonly string[], destinationDir: string): Promise<void> {
    const top = topLevelPaths(sources);
    if (!canMoveInto(top, destinationDir)) return;
    const moves = top.map((from) => ({
      from,
      to: joinPath(destinationDir, baseName(from)),
      entryKind: model.index.getKind(from) ?? ("file" as const),
    }));
    const optId = nextOptimisticId();
    model.index.applyOptimistic(optId, { kind: "move", moves });
    if (destinationDir) model.setExpanded(destinationDir, true);
    model.notifyIndexChange();
    if (!adapter) return;
    try {
      for (const move of moves) {
        await adapter.move(move.from, move.to);
      }
    } catch (error) {
      model.index.rollbackOptimistic(optId);
      model.notifyIndexChange();
      if (moves.length > 1) void adapter.indexed?.requestResync();
      onError?.("Unable to move selected items", error);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget || deleteTarget.length === 0) return;
    const targets = topLevelPaths(deleteTarget);
    setDeleting(true);
    const optIds: string[] = [];
    for (const target of targets) {
      const id = nextOptimisticId();
      optIds.push(id);
      model.index.applyOptimistic(id, { kind: "delete", path: target });
    }
    model.notifyIndexChange();
    try {
      if (adapter) {
        for (const target of targets) {
          await adapter.remove(target);
        }
      }
      setDeleteTarget(null);
      setDeleting(false);
    } catch (error) {
      for (const id of optIds) model.index.rollbackOptimistic(id);
      model.notifyIndexChange();
      setDeleting(false);
      if (targets.length > 1) void adapter?.indexed?.requestResync();
      onError?.("Unable to delete selected items", error);
    }
  }

  function handleTreeKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (state.draft) return;
    const targetEl = event.target as HTMLElement | null;
    if (targetEl?.closest("input, textarea, [data-wb-tree-status]")) return;
    if (isNavKey(event.key)) {
      event.preventDefault();
      const action = navigateTree(state.rows, state.focusedPath, event.key);
      if (action.expand) {
        model.setExpanded(action.expand, true);
        void boundRef.current?.ensureDirectoryLoaded(action.expand);
        return;
      }
      if (action.collapse) {
        model.setExpanded(action.collapse, false);
        return;
      }
      if (action.focus) {
        model.select(action.focus, event.shiftKey ? "range" : "replace", "keyboard");
        requestRowFocus(action.focus);
      }
      return;
    }

    const focusedRow = state.rows.find((row): row is TreeEntryRow => row.type === "entry" && row.focused);
    if (event.key === "Enter" && focusedRow) {
      event.preventDefault();
      if (focusedRow.kind === "directory") {
        toggleDirectory(focusedRow.path);
      } else {
        onOpenFile?.(focusedRow.path, { shouldFocusEditor: true, origin: "keyboard" });
      }
      return;
    }
    if (event.key === "F2" && writable && focusedRow) {
      event.preventDefault();
      model.setDraft({ mode: "rename", path: state.focusedPath ?? focusedRow.path });
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && writable && state.selected.size > 0) {
      event.preventDefault();
      setDeleteTarget(Array.from(state.selected));
      return;
    }
    if (isFilterSeedKey(event)) {
      event.preventDefault();
      setFilterVisible(true);
      model.setFilter(state.filter + event.key);
      queueMicrotask(() => filterRef.current?.focus());
    }
  }

  function handleRowDragStart(row: TreeEntryRow, event: DragEvent<HTMLElement>): void {
    if (!writable) return;
    const paths = state.selected.has(row.path) ? Array.from(state.selected) : [row.path];
    setDraggingPaths(paths);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(TREE_DRAG_MIME, JSON.stringify(paths));
  }

  function handleRowDragOver(
    row: TreeEntryRow,
    segmentPath: string | undefined,
    event: DragEvent<HTMLElement>,
  ): void {
    if (!writable || draggingPaths.length === 0) return;
    const destDir = segmentPath ?? targetDirectory(row.path, row.kind);
    if (!canMoveInto(draggingPaths, destDir)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTarget({ directory: destDir, segmentPath });
    if (destDir) scheduleHoverOpen(destDir);
  }

  function handleRowDrop(
    row: TreeEntryRow,
    segmentPath: string | undefined,
    event: DragEvent<HTMLElement>,
  ): void {
    if (!writable || draggingPaths.length === 0) return;
    event.preventDefault();
    clearHoverOpen();
    const destDir = segmentPath ?? targetDirectory(row.path, row.kind);
    const sources = draggingPaths;
    setDraggingPaths([]);
    setDropTarget(null);
    void executeMove(sources, destDir);
  }

  function handleDragEnd(): void {
    clearHoverOpen();
    setDraggingPaths([]);
    setDropTarget(null);
  }

  function handleTouchPointerDown(row: TreeEntryRow, event: PointerEvent<HTMLElement>): void {
    if (!writable || event.pointerType !== "touch") return;
    const el = event.currentTarget;
    el.setAttribute("draggable", "false");
    const timer = window.setTimeout(() => {
      el.setAttribute("draggable", "true");
      const currentSelected = model.getSnapshot().selected;
      setDraggingPaths(currentSelected.has(row.path) ? Array.from(currentSelected) : [row.path]);
    }, TOUCH_DRAG_HOLD_MS);
    touchDragRef.current = {
      timer,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rowPath: row.path,
      element: el,
    };
  }

  function handleTouchPointerMove(event: PointerEvent<HTMLElement>): void {
    const active = touchDragRef.current;
    if (!active || event.pointerId !== active.pointerId || active.timer === undefined) return;
    if (Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > TOUCH_DRAG_TOLERANCE_PX) {
      window.clearTimeout(active.timer);
      active.timer = undefined;
    }
  }

  function handleTouchPointerUp(): void {
    const active = touchDragRef.current;
    if (!active) return;
    if (active.timer !== undefined) window.clearTimeout(active.timer);
    active.element.setAttribute("draggable", writable ? "true" : "false");
    touchDragRef.current = null;
    clearHoverOpen();
    setDraggingPaths([]);
    setDropTarget(null);
  }

  const activeParentPath = state.focusedPath ? parentOf(state.focusedPath) : undefined;
  const activeIndex = state.rows.findIndex((row) => row.type === "entry" && row.focused);

  // Park focused, editing/draft, and dragged rows so scroll virtualization never unmounts them.
  const parkedIndices: number[] = [];
  for (let i = 0; i < state.rows.length; i += 1) {
    const row = state.rows[i];
    if (!row) continue;
    if (row.type === "draft") {
      parkedIndices.push(i);
    } else if (row.type === "entry" && (row.focused || row.editing || draggingPaths.includes(row.path))) {
      parkedIndices.push(i);
    }
  }

  const menuRow = contextMenu.row;
  const baseMenuItems: readonly ContextMenuItem[] =
    menuRow && writable
      ? [
          {
            id: "new-file",
            label: "New file",
            testId: "wb-tree-ctx-new-file",
            onSelect: () =>
              model.setDraft({
                mode: "create",
                kind: "file",
                parent: targetDirectory(menuRow.path, menuRow.kind),
              }),
          },
          {
            id: "new-folder",
            label: "New folder",
            testId: "wb-tree-ctx-new-folder",
            onSelect: () =>
              model.setDraft({
                mode: "create",
                kind: "directory",
                parent: targetDirectory(menuRow.path, menuRow.kind),
              }),
          },
          {
            id: "rename",
            label: "Rename",
            hint: "F2",
            separatorBefore: true,
            testId: "wb-tree-ctx-rename",
            onSelect: () => model.setDraft({ mode: "rename", path: menuRow.path }),
          },
          {
            id: "delete",
            label: "Delete",
            hint: "⌫",
            danger: true,
            separatorBefore: true,
            testId: "wb-tree-ctx-delete",
            onSelect: () =>
              setDeleteTarget(state.selected.has(menuRow.path) ? Array.from(state.selected) : [menuRow.path]),
          },
        ]
      : [];
  const extraItems: readonly ContextMenuItem[] =
    menuRow && extraContextMenuItems ? extraContextMenuItems(menuRow) : [];
  const menuItems: readonly ContextMenuItem[] = baseMenuItems.concat(extraItems);

  return (
    <div data-wb-tree="" className={className ? `wb-tree ${className}` : "wb-tree"}>
      {filterVisible ? (
        <div
          className="wb-tree-filter-bar"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            const target =
              state.focusedPath ?? state.rows.find((row): row is TreeEntryRow => row.type === "entry")?.path;
            if (target) requestRowFocus(target);
          }}
        >
          <FilterField
            handleRef={filterRef}
            aria-label="Filter files"
            placeholder="Filter files…"
            value={state.filter}
            onValueChange={(next) => model.setFilter(next)}
            onArrowDown={() => {
              const firstEntry = state.rows.find((r): r is TreeEntryRow => r.type === "entry");
              if (firstEntry) {
                model.select(firstEntry.path, "replace", "keyboard");
                requestRowFocus(firstEntry.path);
              }
            }}
          />
        </div>
      ) : null}

      <FileTreeViewport
        rows={state.rows}
        parkedIndices={parkedIndices}
        activeIndex={activeIndex}
        scrollSeq={scrollSeq}
        label={label}
        focusModality={state.focusModality}
        iconPreset={iconPreset}
        dragging={draggingPaths.length > 0}
        onKeyDown={handleTreeKeyDown}
        onSelectStickyAncestor={(dirPath) => model.select(dirPath, "replace", "pointer")}
        onRootDragOver={(event) => {
          if (!writable || draggingPaths.length === 0) return;
          if (!canMoveInto(draggingPaths, "")) return;
          event.preventDefault();
          setDropTarget({ directory: "" });
        }}
        onRootDrop={(event) => {
          if (!writable || draggingPaths.length === 0) return;
          event.preventDefault();
          const sources = draggingPaths;
          handleDragEnd();
          void executeMove(sources, "");
        }}
        renderRow={(row) => {
          if (row.type === "draft") {
            const siblings = new Set(model.index.getChildren(row.parent).map((e) => e.name));
            return (
              <FileTreeDraftRow
                row={row}
                iconPreset={iconPreset}
                siblingNames={siblings}
                onCommit={(parent, kind, name) => void commitCreate(parent, kind, name)}
                onCancel={() => model.setDraft(undefined)}
              />
            );
          }
          if (row.type !== "entry") {
            return (
              <FileTreeStatusRow
                row={row}
                onRetry={(dir) => void boundRef.current?.ensureDirectoryLoaded(dir, { force: true })}
              />
            );
          }
          const siblings = new Set(model.index.getChildren(parentOf(row.path)).map((e) => e.name));
          return (
            <FileTreeRow
              row={row}
              iconPreset={iconPreset}
              activeParentPath={activeParentPath}
              dropTargetDirectory={dropTarget?.directory}
              dropTargetSegment={dropTarget?.segmentPath}
              canDrag={writable}
              siblingNames={siblings}
              focusSeq={
                focusRequest &&
                (focusRequest.path === row.path ||
                  (row.segments?.some((seg) => seg.path === focusRequest.path) ?? false))
                  ? focusRequest.seq
                  : undefined
              }
              onFocusHandled={handleFocusHandled}
              onActivate={handleActivateRow}
              onToggleDirectory={toggleDirectory}
              onSegmentClick={handleSegmentClick}
              onContextMenu={(targetRow, event) => {
                if (!state.selected.has(targetRow.path)) {
                  model.select(targetRow.path, "replace", "pointer");
                }
                setContextMenu({ open: true, x: event.clientX, y: event.clientY, row: targetRow });
              }}
              onCommitRename={(from, next) => void commitRename(from, next)}
              onCancelDraft={() => {
                model.setDraft(undefined);
                requestRowFocus(row.path);
              }}
              onHoverPrefetch={(path) => adapter?.prefetch?.(path)}
              onRowDragStart={handleRowDragStart}
              onRowDragOver={handleRowDragOver}
              onRowDrop={handleRowDrop}
              onRowDragEnd={handleDragEnd}
              onTouchPointerDown={handleTouchPointerDown}
              onTouchPointerMove={handleTouchPointerMove}
              onTouchPointerUp={handleTouchPointerUp}
            />
          );
        }}
      />

      <PointContextMenu
        open={contextMenu.open && menuItems.length > 0}
        x={contextMenu.x}
        y={contextMenu.y}
        items={menuItems}
        label="File tree actions"
        onOpenChange={(open) => setContextMenu((prev) => ({ ...prev, open }))}
      />

      <ConfirmDialog
        open={deleteTarget !== null && deleteTarget.length > 0}
        title={
          deleteTarget && deleteTarget.length === 1
            ? `Delete ${baseName(deleteTarget[0] ?? "")}?`
            : `Delete ${deleteTarget?.length ?? 0} items?`
        }
        description="This removes the selected paths from the workspace."
        confirmLabel="Delete"
        danger
        busy={deleting}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
