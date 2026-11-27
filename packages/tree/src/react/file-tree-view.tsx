import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
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

export interface FileTreeViewHandle {
  focus(): void;
  focusPath(path: string, options?: { readonly behavior?: "auto" | "smooth" }): boolean;
  scrollToPath(
    path: string,
    options?: {
      readonly behavior?: "auto" | "smooth";
      readonly align?: "auto" | "start" | "center" | "end";
    },
  ): boolean;
  openFilter(seed?: string): void;
  closeFilter(): void;
  clearFilter(): void;
  startCreate(parent: string, kind: "file" | "directory"): void;
  startRename(path: string): void;
  collapseAll(): void;
  getScrollElement(): HTMLDivElement | null;
}

export interface FileTreeViewProps {
  /** Optional external `FileTreeModel` (e.g. from a cached `PreparedFileTreeInput`). */
  readonly model?: FileTreeModel;
  /** Optional `FileSystemAdapter` (lazy or indexed) to bind automatically. */
  readonly adapter?: FileSystemAdapter;
  readonly handleRef?: RefObject<FileTreeViewHandle | null>;
  readonly label?: string;
  readonly iconPreset?: "rich" | "stroke";
  readonly showFilter?: boolean;
  readonly filterPlaceholder?: string;
  readonly readOnly?: boolean;
  readonly directDomUpdates?: boolean;
  readonly rowHeight?: number;
  readonly initialScrollTop?: number;
  readonly onScrollTopChange?: (scrollTop: number) => void;
  readonly activePath?: string | null;
  readonly loadingPaths?: ReadonlySet<string>;
  readonly renderRowDecoration?: (row: TreeEntryRow) => ReactNode;
  readonly onRowElementChange?: (path: string, element: HTMLElement | null) => void;
  readonly onOpenFile?: (path: string, focus: ActivationFocusDecision) => void;
  readonly onSelectionChange?: (selectedPaths: readonly string[]) => void;
  readonly onExpandChange?: (dirPath: string, expanded: boolean) => void;
  readonly onRequestContextMenu?: (
    row: TreeEntryRow | null,
    anchor: { readonly x: number; readonly y: number } | HTMLElement,
  ) => void;
  readonly onRequestDelete?: (paths: readonly string[]) => void;
  readonly onCreate?: (parent: string, kind: "file" | "directory", name: string) => void | Promise<void>;
  readonly onRename?: (fromPath: string, toPath: string) => void | Promise<void>;
  readonly onMove?: (
    moves: readonly { readonly from: string; readonly to: string }[],
  ) => void | Promise<void>;
  readonly onExternalDrop?: (dirPath: string, dataTransfer: DataTransfer) => void;
  readonly canDrag?: (paths: readonly string[]) => boolean;
  readonly canDrop?: (sources: readonly string[], destinationDir: string) => boolean;
  readonly onError?: (message: string, error: unknown) => void;
  readonly extraContextMenuItems?: (row: TreeEntryRow) => readonly ContextMenuItem[];
  readonly className?: string;
  readonly style?: CSSProperties;
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
  handleRef,
  label = "File explorer",
  iconPreset = "rich",
  showFilter = true,
  filterPlaceholder = "Filter files…",
  readOnly = false,
  directDomUpdates,
  rowHeight,
  initialScrollTop,
  onScrollTopChange,
  activePath,
  loadingPaths,
  renderRowDecoration,
  onRowElementChange,
  onOpenFile,
  onSelectionChange,
  onExpandChange,
  onRequestContextMenu,
  onRequestDelete,
  onCreate,
  onRename,
  onMove,
  onExternalDrop,
  canDrag,
  canDrop,
  onError,
  extraContextMenuItems,
  className,
  style,
}: FileTreeViewProps) {
  const [internalModel] = useState(() => new FileTreeModel());
  const model = externalModel ?? internalModel;
  const state = useSubscribable(model);

  const boundRef = useRef<BoundFileTreeAdapter | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<FilterFieldHandle | null>(null);
  const hoverOpenTimerRef = useRef<number | undefined>(undefined);
  const hoverOpenDirRef = useRef<string | undefined>(undefined);
  const optimisticSeqRef = useRef(0);
  const draggingPathsRef = useRef<readonly string[]>([]);
  const touchSuppressClickUntilRef = useRef(0);
  const touchDragRef = useRef<{
    timer: number | undefined;
    pointerId: number;
    startX: number;
    startY: number;
    rowPath: string;
    element: HTMLElement;
    active: boolean;
    sources: readonly string[];
    dropTarget: { readonly directory: string; readonly segmentPath?: string } | null;
  } | null>(null);

  const [filterVisible, setFilterVisible] = useState(showFilter);
  const [draggingPaths, setDraggingPaths] = useState<readonly string[]>([]);
  const [touchDragging, setTouchDragging] = useState(false);
  const [touchDragY, setTouchDragY] = useState<number | null>(null);
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
  const [scrollRequest, setScrollRequest] = useState<{
    readonly seq: number;
    readonly index: number;
    readonly behavior: "auto" | "smooth";
    readonly align: "auto" | "start" | "center" | "end";
  }>({ seq: 0, index: -1, behavior: "auto", align: "auto" });
  const focusSeqRef = useRef(0);
  const readOnlyRef = useRef(readOnly);
  const lastSelectedRef = useRef<ReadonlySet<string>>(state.selected);

  useLayoutEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);

  useEffect(() => {
    if (!onSelectionChange) return;
    if (lastSelectedRef.current === state.selected) return;
    lastSelectedRef.current = state.selected;
    onSelectionChange(Array.from(state.selected));
  }, [onSelectionChange, state.selected]);

  const adapterWritable = useSubscribable(adapter?.writable ?? ALWAYS_WRITABLE);
  const writable = !readOnly && adapterWritable;

  function isCurrentlyWritable(): boolean {
    return !readOnlyRef.current && (adapter ? adapter.writable.getSnapshot() : true);
  }

  function findRowIndexByPath(targetPath: string): number {
    const rows = model.getSnapshot().rows;
    return rows.findIndex(
      (row) =>
        row.type === "entry" &&
        (row.path === targetPath || (row.segments?.some((seg) => seg.path === targetPath) ?? false)),
    );
  }

  function requestRowFocus(
    path: string,
    options?: {
      readonly behavior?: "auto" | "smooth";
      readonly align?: "auto" | "start" | "center" | "end";
    },
  ): void {
    focusSeqRef.current += 1;
    const seq = focusSeqRef.current;
    const idx = findRowIndexByPath(path);
    setScrollRequest({
      seq,
      index: idx,
      behavior: options?.behavior ?? "auto",
      align: options?.align ?? "auto",
    });
    setFocusRequest({ path, seq });
  }

  function requestRowScroll(
    path: string,
    options?: {
      readonly behavior?: "auto" | "smooth";
      readonly align?: "auto" | "start" | "center" | "end";
    },
  ): boolean {
    const idx = findRowIndexByPath(path);
    if (idx < 0) return false;
    focusSeqRef.current += 1;
    setScrollRequest({
      seq: focusSeqRef.current,
      index: idx,
      behavior: options?.behavior ?? "auto",
      align: options?.align ?? "auto",
    });
    return true;
  }

  useImperativeHandle(handleRef, () => ({
    focus() {
      const snap = model.getSnapshot();
      const target =
        snap.focusedPath ?? snap.rows.find((row): row is TreeEntryRow => row.type === "entry")?.path;
      if (target) {
        model.setFocusedPath(target, "keyboard");
        requestRowFocus(target);
        return;
      }
      scrollerRef.current?.focus();
    },
    focusPath(path, options) {
      if (!model.index.hasPath(path)) return false;
      model.expandAllAncestors(path);
      if (findRowIndexByPath(path) < 0) return false;
      model.setFocusedPath(path, "keyboard");
      requestRowFocus(path, options);
      return true;
    },
    scrollToPath(path, options) {
      if (!model.index.hasPath(path)) return false;
      model.expandAllAncestors(path);
      return requestRowScroll(path, options);
    },
    openFilter(seed) {
      setFilterVisible(true);
      if (seed !== undefined) model.setFilter(seed);
      queueMicrotask(() => filterRef.current?.focus());
    },
    closeFilter() {
      model.setFilter("");
      if (!showFilter) setFilterVisible(false);
    },
    clearFilter() {
      model.setFilter("");
    },
    startCreate(parent, kind) {
      if (!isCurrentlyWritable()) return;
      if (parent !== "" && model.index.getKind(parent) !== "directory") return;
      if (model.getSnapshot().filter) model.setFilter("");
      model.setDraft({ mode: "create", kind, parent });
    },
    startRename(path) {
      if (!isCurrentlyWritable() || !model.index.hasPath(path)) return;
      model.expandAllAncestors(path);
      if (findRowIndexByPath(path) < 0 && model.getSnapshot().filter) {
        model.setFilter("");
      }
      if (findRowIndexByPath(path) < 0) return;
      model.setDraft({ mode: "rename", path });
    },
    collapseAll() {
      model.collapseAll();
    },
    getScrollElement() {
      return scrollerRef.current;
    },
  }));

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

  // Prevent native touch scroll/pan takeover while an active touch long-press drag is in progress.
  useEffect(() => {
    if (!touchDragging) return;
    const preventTouchScroll = (event: TouchEvent): void => {
      if (event.cancelable) event.preventDefault();
    };
    window.addEventListener("touchmove", preventTouchScroll, { passive: false });
    return () => {
      window.removeEventListener("touchmove", preventTouchScroll);
    };
  }, [touchDragging]);

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
    onExpandChange?.(dirPath, opened);
    if (opened) void boundRef.current?.ensureDirectoryLoaded(dirPath);
  }

  function handleActivateRow(row: TreeEntryRow, event: MouseEvent<HTMLElement>): void {
    if (Date.now() < touchSuppressClickUntilRef.current) {
      touchSuppressClickUntilRef.current = 0;
      return;
    }
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

  function handleSegmentClick(
    row: TreeEntryRow,
    segmentPath: string,
    _event: MouseEvent<HTMLButtonElement>,
  ): void {
    model.select(segmentPath, "replace", "pointer");
    if (segmentPath === row.path) {
      toggleDirectory(row.path);
    }
  }

  async function commitCreate(parent: string, kind: "file" | "directory", name: string): Promise<void> {
    model.setDraft(undefined);
    if (!isCurrentlyWritable()) return;
    if (onCreate) {
      try {
        await onCreate(parent, kind, name);
      } catch (error) {
        onError?.(`Unable to create ${name}`, error);
      }
      return;
    }
    const fullPath = joinPath(parent, name);
    const optId = nextOptimisticId();
    model.index.applyOptimistic(
      optId,
      { kind: "create", path: fullPath, entryKind: kind },
      { inFlight: Boolean(adapter) },
    );
    model.notifyIndexChange();
    model.select(fullPath, "replace", "keyboard");
    requestRowFocus(fullPath);
    if (!adapter) return;
    try {
      if (kind === "directory") await adapter.createDirectory(fullPath);
      else await adapter.createFile(fullPath, "");
      model.index.settleOptimistic(optId);
      model.notifyIndexChange();
    } catch (error) {
      model.index.rollbackOptimistic(optId);
      model.notifyIndexChange();
      onError?.(`Unable to create ${name}`, error);
    }
  }

  async function commitRename(fromPath: string, nextName: string): Promise<void> {
    const toPath = joinPath(parentOf(fromPath), nextName);
    model.setDraft(undefined);
    if (!isCurrentlyWritable() || toPath === fromPath) {
      requestRowFocus(fromPath);
      return;
    }
    if (onRename) {
      try {
        await onRename(fromPath, toPath);
        requestRowFocus(toPath);
      } catch (error) {
        requestRowFocus(fromPath);
        onError?.(`Unable to rename ${baseName(fromPath)}`, error);
      }
      return;
    }
    const entryKind = model.index.getKind(fromPath) ?? "file";
    const optId = nextOptimisticId();
    model.index.applyOptimistic(
      optId,
      {
        kind: "move",
        moves: [{ from: fromPath, to: toPath, entryKind }],
      },
      { inFlight: Boolean(adapter) },
    );
    model.notifyIndexChange();
    model.select(toPath, "replace", "keyboard");
    requestRowFocus(toPath);
    if (!adapter) return;
    try {
      await adapter.move(fromPath, toPath);
      model.index.settleOptimistic(optId);
      model.notifyIndexChange();
    } catch (error) {
      model.index.rollbackOptimistic(optId);
      model.notifyIndexChange();
      onError?.(`Unable to rename ${baseName(fromPath)}`, error);
    }
  }

  function rollbackOptimisticFrom(optIds: readonly string[], startIndex: number): void {
    for (let j = startIndex; j < optIds.length; j += 1) {
      const pendingId = optIds[j];
      if (pendingId) model.index.rollbackOptimistic(pendingId);
    }
  }

  async function executeMove(sources: readonly string[], destinationDir: string): Promise<void> {
    if (!isCurrentlyWritable()) return;
    const top = topLevelPaths(sources);
    if (!canMoveInto(top, destinationDir)) return;
    if (canDrop && !canDrop(top, destinationDir)) return;
    const moves = top.map((from) => ({
      from,
      to: joinPath(destinationDir, baseName(from)),
      entryKind: model.index.getKind(from) ?? ("file" as const),
    }));
    if (onMove) {
      if (destinationDir) model.setExpanded(destinationDir, true);
      try {
        await onMove(moves.map(({ from, to }) => ({ from, to })));
      } catch (error) {
        onError?.("Unable to move selected items", error);
      }
      return;
    }
    const optIds: string[] = [];
    for (const move of moves) {
      const id = nextOptimisticId();
      optIds.push(id);
      model.index.applyOptimistic(id, { kind: "move", moves: [move] }, { inFlight: Boolean(adapter) });
    }
    if (destinationDir) model.setExpanded(destinationDir, true);
    model.notifyIndexChange();
    if (!adapter) return;
    let completed = 0;
    try {
      for (let i = 0; i < moves.length; i += 1) {
        const move = moves[i];
        if (!move) continue;
        if (!isCurrentlyWritable()) {
          rollbackOptimisticFrom(optIds, i);
          model.notifyIndexChange();
          if (completed > 0) void adapter.indexed?.requestResync();
          return;
        }
        await adapter.move(move.from, move.to);
        const doneId = optIds[i];
        if (doneId) model.index.settleOptimistic(doneId);
        completed += 1;
      }
      model.notifyIndexChange();
    } catch (error) {
      rollbackOptimisticFrom(optIds, completed);
      model.notifyIndexChange();
      if (completed > 0) void adapter.indexed?.requestResync();
      onError?.("Unable to move selected items", error);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget || deleteTarget.length === 0) return;
    if (!isCurrentlyWritable()) {
      setDeleteTarget(null);
      return;
    }
    const targets = topLevelPaths(deleteTarget);
    setDeleting(true);
    const optIds: string[] = [];
    for (const target of targets) {
      const id = nextOptimisticId();
      optIds.push(id);
      model.index.applyOptimistic(id, { kind: "delete", path: target }, { inFlight: Boolean(adapter) });
    }
    model.notifyIndexChange();
    let completed = 0;
    try {
      for (let i = 0; adapter && i < targets.length; i += 1) {
        const target = targets[i];
        if (!target) continue;
        if (!isCurrentlyWritable()) {
          rollbackOptimisticFrom(optIds, i);
          model.notifyIndexChange();
          if (completed > 0) void adapter.indexed?.requestResync();
          setDeleteTarget(null);
          setDeleting(false);
          return;
        }
        await adapter.remove(target);
        const doneId = optIds[i];
        if (doneId) model.index.settleOptimistic(doneId);
        completed += 1;
      }
      model.notifyIndexChange();
      setDeleteTarget(null);
      setDeleting(false);
    } catch (error) {
      rollbackOptimisticFrom(optIds, completed);
      model.notifyIndexChange();
      setDeleting(false);
      if (completed > 0) void adapter?.indexed?.requestResync();
      onError?.("Unable to delete selected items", error);
    }
  }

  function requestDeletePaths(paths: readonly string[]): void {
    if (paths.length === 0) return;
    if (onRequestDelete) {
      onRequestDelete(paths);
      return;
    }
    setDeleteTarget(paths);
  }

  function openMenuFor(
    row: TreeEntryRow | null,
    anchor: { readonly x: number; readonly y: number } | HTMLElement,
  ): void {
    if (onRequestContextMenu) {
      onRequestContextMenu(row, anchor);
      return;
    }
    if (!row) return;
    const point =
      anchor instanceof HTMLElement
        ? (() => {
            const rect = anchor.getBoundingClientRect();
            return { x: rect.left + 24, y: rect.bottom };
          })()
        : anchor;
    setContextMenu({ open: true, x: point.x, y: point.y, row });
  }

  function handleTreeKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (state.draft) {
      const hasVisibleDraft = state.rows.some(
        (row) => row.type === "draft" || (row.type === "entry" && row.editing),
      );
      if (hasVisibleDraft) return;
      model.setDraft(undefined);
    }
    const targetEl = event.target as HTMLElement | null;
    if (targetEl?.closest("input, textarea, [data-wb-tree-status]")) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      model.selectAll();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
      event.preventDefault();
      setFilterVisible(true);
      queueMicrotask(() => filterRef.current?.focus());
      return;
    }
    if (isNavKey(event.key)) {
      event.preventDefault();
      const action = navigateTree(state.rows, state.focusedPath, event.key);
      if (action.expand) {
        model.setExpanded(action.expand, true);
        onExpandChange?.(action.expand, true);
        void boundRef.current?.ensureDirectoryLoaded(action.expand);
        return;
      }
      if (action.collapse) {
        model.setExpanded(action.collapse, false);
        onExpandChange?.(action.collapse, false);
        if (action.focus) {
          model.select(action.focus, "replace", "keyboard");
          requestRowFocus(action.focus);
        }
        return;
      }
      if (action.focus) {
        model.select(action.focus, event.shiftKey ? "range" : "replace", "keyboard");
        requestRowFocus(action.focus);
      }
      return;
    }

    const focusedRow = state.rows.find((row): row is TreeEntryRow => row.type === "entry" && row.focused);
    if (event.key === " " && focusedRow && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      model.select(focusedRow.path, "toggle", "keyboard");
      return;
    }
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
      requestDeletePaths(Array.from(state.selected));
      return;
    }
    if ((event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) && focusedRow) {
      event.preventDefault();
      const anchor = targetEl?.closest<HTMLElement>("[data-wb-tree-row]");
      if (anchor) openMenuFor(focusedRow, anchor);
      return;
    }
    if (isFilterSeedKey(event)) {
      event.preventDefault();
      setFilterVisible(true);
      model.setFilter(state.filter + event.key);
      queueMicrotask(() => filterRef.current?.focus());
    }
  }

  function resolveTouchDropTarget(
    clientX: number,
    clientY: number,
    sources: readonly string[],
  ): { readonly directory: string; readonly segmentPath?: string } | null {
    if (typeof document.elementFromPoint !== "function") return null;
    const hit = document.elementFromPoint(clientX, clientY);
    if (!hit) return null;
    const segEl = hit.closest<HTMLElement>("[data-wb-drop-segment]");
    if (segEl?.dataset.wbDropSegment) {
      const segPath = segEl.dataset.wbDropSegment;
      const top = topLevelPaths(sources);
      if (!canMoveInto(top, segPath) || (canDrop && !canDrop(top, segPath))) return null;
      return { directory: segPath, segmentPath: segPath };
    }
    const rowEl = hit.closest<HTMLElement>("[data-wb-tree-row]");
    if (rowEl?.dataset.path) {
      const kind = rowEl.dataset.kind === "directory" ? "directory" : "file";
      const destDir = targetDirectory(rowEl.dataset.path, kind);
      const top = topLevelPaths(sources);
      if (!canMoveInto(top, destDir) || (canDrop && !canDrop(top, destDir))) return null;
      return { directory: destDir };
    }
    const scrollerEl = hit.closest<HTMLElement>("[data-wb-tree-scroller]");
    const top = topLevelPaths(sources);
    if (scrollerEl && canMoveInto(top, "") && (!canDrop || canDrop(top, ""))) {
      return { directory: "" };
    }
    return null;
  }

  function clearDragState(): void {
    clearHoverOpen();
    draggingPathsRef.current = [];
    setDraggingPaths([]);
    setTouchDragging(false);
    setDropTarget(null);
    setTouchDragY(null);
  }

  function handleRowDragStart(row: TreeEntryRow, event: DragEvent<HTMLElement>): void {
    if (!isCurrentlyWritable()) return;
    const paths = state.selected.has(row.path) ? Array.from(state.selected) : [row.path];
    if (canDrag && !canDrag(paths)) {
      event.preventDefault();
      return;
    }
    draggingPathsRef.current = paths;
    setDraggingPaths(paths);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(TREE_DRAG_MIME, JSON.stringify(paths));
  }

  function handleRowDragOver(
    row: TreeEntryRow,
    segmentPath: string | undefined,
    event: DragEvent<HTMLElement>,
  ): void {
    if (!isCurrentlyWritable()) return;
    const sources = draggingPathsRef.current;
    const destDir = segmentPath ?? targetDirectory(row.path, row.kind);
    if (sources.length === 0) {
      if (!onExternalDrop || !event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setDropTarget({ directory: destDir, segmentPath });
      if (destDir) scheduleHoverOpen(destDir);
      return;
    }
    if (!canMoveInto(sources, destDir)) return;
    if (canDrop && !canDrop(topLevelPaths(sources), destDir)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDropTarget({ directory: destDir, segmentPath });
    if (destDir) scheduleHoverOpen(destDir);
  }

  function handleRowDrop(
    row: TreeEntryRow,
    segmentPath: string | undefined,
    event: DragEvent<HTMLElement>,
  ): void {
    if (!isCurrentlyWritable()) return;
    const sources = draggingPathsRef.current;
    const destDir = segmentPath ?? targetDirectory(row.path, row.kind);
    if (sources.length === 0) {
      if (!onExternalDrop || !event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
      clearDragState();
      onExternalDrop(destDir, event.dataTransfer);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    clearDragState();
    void executeMove(sources, destDir);
  }

  function handleDragEnd(): void {
    clearDragState();
  }

  function handleTouchPointerDown(row: TreeEntryRow, event: PointerEvent<HTMLElement>): void {
    if (!isCurrentlyWritable() || event.pointerType !== "touch") return;
    const el = event.currentTarget;
    el.setAttribute("draggable", "false");
    const pointerId = event.pointerId;
    const timer = window.setTimeout(() => {
      const current = touchDragRef.current;
      if (!current || current.pointerId !== pointerId) return;
      const currentSelected = model.getSnapshot().selected;
      const sources = currentSelected.has(row.path) ? Array.from(currentSelected) : [row.path];
      if (canDrag && !canDrag(sources)) {
        current.timer = undefined;
        return;
      }
      current.timer = undefined;
      current.active = true;
      current.sources = sources;
      draggingPathsRef.current = sources;
      setDraggingPaths(sources);
      setTouchDragging(true);
      setTouchDragY(current.startY);
      if (typeof el.setPointerCapture === "function") {
        try {
          el.setPointerCapture(pointerId);
        } catch {
          // Pointer capture is optional on synthetic events.
        }
      }
    }, TOUCH_DRAG_HOLD_MS);
    touchDragRef.current = {
      timer,
      pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rowPath: row.path,
      element: el,
      active: false,
      sources: [],
      dropTarget: null,
    };
  }

  function handleTouchPointerMove(event: PointerEvent<HTMLElement>): void {
    const active = touchDragRef.current;
    if (!active || event.pointerId !== active.pointerId) return;
    if (!active.active) {
      if (
        active.timer !== undefined &&
        Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > TOUCH_DRAG_TOLERANCE_PX
      ) {
        window.clearTimeout(active.timer);
        active.timer = undefined;
      }
      return;
    }
    event.preventDefault();
    setTouchDragY(event.clientY);
    const target = resolveTouchDropTarget(event.clientX, event.clientY, active.sources);
    active.dropTarget = target;
    setDropTarget(target);
    if (target?.directory) scheduleHoverOpen(target.directory);
    else clearHoverOpen();
  }

  function handleTouchPointerUp(event: PointerEvent<HTMLElement>): void {
    const active = touchDragRef.current;
    if (!active || event.pointerId !== active.pointerId) return;
    if (active.timer !== undefined) window.clearTimeout(active.timer);
    active.element.setAttribute("draggable", writable ? "true" : "false");
    if (typeof active.element.releasePointerCapture === "function") {
      try {
        active.element.releasePointerCapture(active.pointerId);
      } catch {
        // Ignore if capture was not acquired.
      }
    }
    touchDragRef.current = null;
    if (!active.active) return;

    touchSuppressClickUntilRef.current = Date.now() + 400;
    const finalTarget = resolveTouchDropTarget(event.clientX, event.clientY, active.sources);
    const sources = active.sources;
    clearDragState();
    if (finalTarget && sources.length > 0) {
      void executeMove(sources, finalTarget.directory);
    }
  }

  function handleTouchPointerCancel(): void {
    const active = touchDragRef.current;
    if (!active) return;
    if (active.timer !== undefined) window.clearTimeout(active.timer);
    active.element.setAttribute("draggable", writable ? "true" : "false");
    touchDragRef.current = null;
    if (active.active) clearDragState();
  }

  const activeParentPath = state.focusedPath ? parentOf(state.focusedPath) : undefined;
  const activeIndex = state.rows.findIndex((row) => row.type === "entry" && row.focused);
  const firstEntryIndex = state.rows.findIndex((row) => row.type === "entry");
  const tabStopIndex = activeIndex >= 0 ? activeIndex : firstEntryIndex;

  // Park focused, tab-stop, editing/draft, and dragged rows so scroll virtualization never unmounts them.
  const parkedIndices: number[] = [];
  for (let i = 0; i < state.rows.length; i += 1) {
    const row = state.rows[i];
    if (!row) continue;
    if (row.type === "draft") {
      parkedIndices.push(i);
    } else if (
      row.type === "entry" &&
      (row.focused || i === tabStopIndex || row.editing || draggingPaths.includes(row.path))
    ) {
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
              requestDeletePaths(
                state.selected.has(menuRow.path) ? Array.from(state.selected) : [menuRow.path],
              ),
          },
        ]
      : [];
  const extraItems: readonly ContextMenuItem[] =
    menuRow && extraContextMenuItems ? extraContextMenuItems(menuRow) : [];
  const menuItems: readonly ContextMenuItem[] = baseMenuItems.concat(extraItems);

  return (
    <div data-wb-tree="" className={className ? `wb-tree ${className}` : "wb-tree"} style={style}>
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
            placeholder={filterPlaceholder}
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
        activeIndex={scrollRequest.index >= 0 ? scrollRequest.index : activeIndex}
        scrollSeq={scrollRequest.seq}
        scrollBehavior={scrollRequest.behavior}
        scrollAlign={scrollRequest.align}
        rowHeight={rowHeight}
        initialScrollTop={initialScrollTop}
        onScrollTopChange={onScrollTopChange}
        scrollerRef={scrollerRef}
        hasEntryTabStop={tabStopIndex >= 0}
        label={label}
        focusModality={state.focusModality}
        iconPreset={iconPreset}
        dragging={draggingPaths.length > 0}
        touchDragging={touchDragging}
        touchDragY={touchDragY}
        directDomUpdates={directDomUpdates}
        onKeyDown={handleTreeKeyDown}
        onSelectStickyAncestor={(dirPath) => model.select(dirPath, "replace", "pointer")}
        onRootContextMenu={
          onRequestContextMenu
            ? (event) => openMenuFor(null, { x: event.clientX, y: event.clientY })
            : undefined
        }
        onRootDragLeave={() => {
          clearHoverOpen();
          setDropTarget(null);
        }}
        onRootDragOver={(event) => {
          if (!isCurrentlyWritable()) return;
          const sources = draggingPathsRef.current;
          if (sources.length === 0) {
            if (!onExternalDrop || !event.dataTransfer?.types.includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setDropTarget({ directory: "" });
            return;
          }
          if (!canMoveInto(sources, "")) return;
          if (canDrop && !canDrop(topLevelPaths(sources), "")) return;
          event.preventDefault();
          setDropTarget({ directory: "" });
        }}
        onRootDrop={(event) => {
          if (!isCurrentlyWritable()) return;
          const sources = draggingPathsRef.current;
          if (sources.length === 0) {
            if (!onExternalDrop || !event.dataTransfer?.types.includes("Files")) return;
            event.preventDefault();
            clearDragState();
            onExternalDrop("", event.dataTransfer);
            return;
          }
          event.preventDefault();
          clearDragState();
          void executeMove(sources, "");
        }}
        renderRow={(row, index) => {
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
              isTabStop={index === tabStopIndex}
              active={activePath === row.path}
              loading={loadingPaths?.has(row.path) ?? false}
              decoration={renderRowDecoration?.(row)}
              focusSeq={
                focusRequest &&
                (focusRequest.path === row.path ||
                  (row.segments?.some((seg) => seg.path === focusRequest.path) ?? false))
                  ? focusRequest.seq
                  : undefined
              }
              onFocusHandled={handleFocusHandled}
              onRowElementChange={onRowElementChange}
              onRowFocus={(focusedEntry) => {
                const current = model.getSnapshot();
                const alreadyFocused =
                  current.focusedPath === focusedEntry.path ||
                  (focusedEntry.segments?.some((seg) => seg.path === current.focusedPath) ?? false);
                if (!alreadyFocused) {
                  model.setFocusedPath(
                    focusedEntry.path,
                    current.focusedPath === undefined ? "keyboard" : current.focusModality,
                  );
                }
              }}
              onActivate={handleActivateRow}
              onDoubleClickRename={
                writable
                  ? (targetRow, targetPath) =>
                      model.setDraft({ mode: "rename", path: targetPath ?? targetRow.path })
                  : undefined
              }
              onToggleDirectory={toggleDirectory}
              onSegmentClick={handleSegmentClick}
              onContextMenu={(targetRow, event) => {
                if (!state.selected.has(targetRow.path)) {
                  model.select(targetRow.path, "replace", "pointer");
                }
                openMenuFor(targetRow, { x: event.clientX, y: event.clientY });
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
              onTouchPointerCancel={handleTouchPointerCancel}
            />
          );
        }}
      />

      {!onRequestContextMenu ? (
        <PointContextMenu
          open={contextMenu.open && menuItems.length > 0}
          x={contextMenu.x}
          y={contextMenu.y}
          items={menuItems}
          label="File tree actions"
          onOpenChange={(open) => setContextMenu((prev) => ({ ...prev, open }))}
        />
      ) : null}

      {!onRequestDelete ? (
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
      ) : null}
    </div>
  );
}
