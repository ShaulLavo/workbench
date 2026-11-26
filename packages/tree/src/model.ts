import type {
  EntryKind,
  FileTreeGitState,
  GitStatusCode,
  IndexedTreePatch,
  IndexedTreeSnapshot,
  Subscribable,
} from "@shaulavo/workbench-core";
import {
  FileTreeIndex,
  prepareFileTreeInput,
  type PatchApplyResult,
  type PreparedFileTreeInput,
  type RawTreeEntry,
} from "./index-store";
import { ancestorsOf, isInside, isSameOrInside, joinPath, parentOf } from "./paths";

export type TreeDraft =
  | { readonly mode: "create"; readonly kind: EntryKind; readonly parent: string }
  | { readonly mode: "rename"; readonly path: string };

export interface FolderSegment {
  readonly name: string;
  readonly path: string;
}

export type SelectionPillEdge = "single" | "start" | "middle" | "end";

export interface TreeEntryRow {
  readonly type: "entry";
  readonly key: string;
  readonly path: string;
  readonly name: string;
  readonly kind: EntryKind;
  readonly depth: number;
  readonly expanded: boolean;
  readonly loading: boolean;
  readonly editing: boolean;
  readonly selected: boolean;
  readonly selectionEdge?: SelectionPillEdge;
  readonly focused: boolean;
  readonly ancestorPaths: readonly string[];
  readonly segments?: readonly FolderSegment[];
  readonly contextOnly?: boolean;
  readonly gitStatus?: GitStatusCode;
  readonly hasChangedDescendant?: boolean;
  readonly ignored?: boolean;
}

export interface TreeDraftRow {
  readonly type: "draft";
  readonly key: string;
  readonly parent: string;
  readonly kind: EntryKind;
  readonly depth: number;
  readonly ancestorPaths: readonly string[];
}

export interface TreeStatusRow {
  readonly type: "loading" | "error";
  readonly key: string;
  readonly directory: string;
  readonly depth: number;
  readonly ancestorPaths: readonly string[];
  readonly message: string;
  readonly retryable?: boolean;
}

export type TreeRow = TreeEntryRow | TreeDraftRow | TreeStatusRow;

export interface VisibleTreeOptions {
  readonly compactFolders?: boolean;
  readonly filter?: string;
  readonly includeIgnoredInFilter?: boolean;
  readonly git?: FileTreeGitState;
  readonly selected?: ReadonlySet<string>;
  readonly focusedPath?: string;
}

export interface StickyAncestorsState {
  readonly rows: readonly TreeEntryRow[];
  /** Vertical push-up offset in pixels (0..rowHeight) so the bottom sticky header clears the next group. */
  readonly pushUpPx: number;
}

export type TreeNavigationKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

export interface TreeNavigationAction {
  readonly focus?: string;
  readonly expand?: string;
  readonly collapse?: string;
}

function blocksCompaction(path: string, draft: TreeDraft | undefined): boolean {
  if (!draft) return false;
  if (draft.mode === "create") return draft.parent === path;
  return draft.path === path;
}

function isIgnoredPath(
  path: string,
  ancestors: readonly string[],
  git: FileTreeGitState | undefined,
): boolean {
  if (!git) return false;
  if (git.statusByPath.get(path) === "ignored" || git.ignoredDirectories.has(path)) return true;
  for (const anc of ancestors) {
    if (git.ignoredDirectories.has(anc)) return true;
  }
  return false;
}

function compactDirectoryChain(
  index: FileTreeIndex,
  expanded: ReadonlySet<string>,
  startName: string,
  startPath: string,
  draft: TreeDraft | undefined,
  compact: boolean,
): { readonly segments: FolderSegment[]; readonly path: string; readonly open: boolean } {
  const segments: FolderSegment[] = [{ name: startName, path: startPath }];
  let currentPath = startPath;
  let currentOpen = expanded.has(currentPath);
  if (!compact) return { segments, path: currentPath, open: currentOpen };

  while (currentOpen && !blocksCompaction(currentPath, draft)) {
    const loadState = index.getDirectoryLoadState(currentPath);
    if (loadState.status !== "loaded") break;
    const children = index.getChildren(currentPath);
    const only = children.length === 1 ? children[0] : undefined;
    if (!only || only.kind !== "directory") break;
    const nextPath = joinPath(currentPath, only.name);
    if (draft?.mode === "rename" && draft.path === nextPath) break;
    segments.push({ name: only.name, path: nextPath });
    currentPath = nextPath;
    currentOpen = expanded.has(currentPath);
  }
  return { segments, path: currentPath, open: currentOpen };
}

function computeFilterSets(
  index: FileTreeIndex,
  needle: string,
  git: FileTreeGitState | undefined,
  includeIgnored: boolean,
): { readonly matched: Set<string>; readonly contextDirs: Set<string> } {
  const matched = new Set<string>();
  const contextDirs = new Set<string>();
  const ignoredDirs = !includeIgnored ? git?.ignoredDirectories : undefined;

  const walk = (dir: string): void => {
    for (const entry of index.getChildren(dir)) {
      const path = joinPath(dir, entry.name);
      if (ignoredDirs?.has(path)) continue;
      if (path.toLocaleLowerCase().includes(needle) || entry.name.toLocaleLowerCase().includes(needle)) {
        matched.add(path);
        for (const anc of ancestorsOf(path)) contextDirs.add(anc);
      }
      if (entry.kind === "directory") walk(path);
    }
  };
  walk("");
  return { matched, contextDirs };
}

function assignSelectionEdges(rows: TreeRow[]): void {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row || row.type !== "entry" || !row.selected) continue;
    const prev = rows[i - 1];
    const next = rows[i + 1];
    const prevSelected = prev?.type === "entry" && prev.selected;
    const nextSelected = next?.type === "entry" && next.selected;
    let edge: SelectionPillEdge = "single";
    if (prevSelected && nextSelected) edge = "middle";
    else if (prevSelected) edge = "end";
    else if (nextSelected) edge = "start";
    rows[i] = { ...row, selectionEdge: edge };
  }
}

/** Projects the tree index, expansion set, filter, draft, and git state into flat virtualizable rows. */
export function computeVisibleRows(
  index: FileTreeIndex,
  expanded: ReadonlySet<string>,
  draft?: TreeDraft,
  options?: VisibleTreeOptions,
): TreeRow[] {
  const compact = options?.compactFolders ?? true;
  const rawFilter = options?.filter?.trim() ?? "";
  const needle = rawFilter.toLocaleLowerCase();
  const git = options?.git;
  const selected = options?.selected;
  const focusedPath = options?.focusedPath;
  const filterSets = needle
    ? computeFilterSets(index, needle, git, options?.includeIgnoredInFilter ?? false)
    : null;

  const rows: TreeRow[] = [];

  const appendDir = (dir: string, depth: number, ancestors: readonly string[]): void => {
    if (!filterSets && draft?.mode === "create" && draft.parent === dir) {
      rows.push({
        type: "draft",
        key: "\0draft",
        parent: dir,
        kind: draft.kind,
        depth,
        ancestorPaths: ancestors,
      });
    }

    const loadState = index.getDirectoryLoadState(dir);
    if (!filterSets && dir !== "" && loadState.status === "loading") {
      rows.push({
        type: "loading",
        key: `\0loading:${dir}`,
        directory: dir,
        depth,
        ancestorPaths: ancestors,
        message: "Loading…",
      });
      return;
    }
    if (!filterSets && dir !== "" && loadState.status === "error") {
      rows.push({
        type: "error",
        key: `\0error:${dir}`,
        directory: dir,
        depth,
        ancestorPaths: ancestors,
        message: loadState.message,
        retryable: loadState.retryable,
      });
      return;
    }

    for (const entry of index.getChildren(dir)) {
      const startPath = joinPath(dir, entry.name);
      if (filterSets && !filterSets.matched.has(startPath) && !filterSets.contextDirs.has(startPath)) {
        continue;
      }

      if (entry.kind !== "directory") {
        const ignored = isIgnoredPath(startPath, ancestors, git);
        rows.push({
          type: "entry",
          key: startPath,
          path: startPath,
          name: entry.name,
          kind: "file",
          depth,
          expanded: false,
          loading: false,
          editing: draft?.mode === "rename" && draft.path === startPath,
          selected: selected?.has(startPath) ?? false,
          focused: focusedPath === startPath,
          ancestorPaths: ancestors,
          gitStatus: git?.statusByPath.get(startPath),
          ignored,
        });
        continue;
      }

      const chain = filterSets
        ? { segments: [{ name: entry.name, path: startPath }], path: startPath, open: true }
        : compactDirectoryChain(index, expanded, entry.name, startPath, draft, compact);
      const isRowSelected =
        (selected?.has(chain.path) ?? false) ||
        (chain.segments.length > 1 && chain.segments.some((seg) => selected?.has(seg.path) ?? false));
      const isRowFocused =
        focusedPath === chain.path ||
        (chain.segments.length > 1 && chain.segments.some((seg) => seg.path === focusedPath));
      const ignored = isIgnoredPath(chain.path, ancestors, git);
      const dirState = index.getDirectoryLoadState(chain.path);

      rows.push({
        type: "entry",
        key: startPath,
        path: chain.path,
        name: chain.segments.map((seg) => seg.name).join("/"),
        kind: "directory",
        depth,
        expanded: chain.open,
        loading: chain.open && dirState.status === "loading",
        editing: draft?.mode === "rename" && draft.path === chain.path,
        selected: isRowSelected,
        focused: isRowFocused,
        ancestorPaths: ancestors,
        segments: chain.segments.length > 1 ? chain.segments : undefined,
        contextOnly: filterSets ? !filterSets.matched.has(chain.path) : undefined,
        gitStatus: git?.statusByPath.get(chain.path),
        hasChangedDescendant: git?.directoriesWithChanges.has(chain.path),
        ignored,
      });

      if (chain.open) {
        appendDir(chain.path, depth + 1, ancestors.concat([chain.path]));
      }
    }
  };

  appendDir("", 0, []);
  assignSelectionEdges(rows);
  return rows;
}

/**
 * Computes pinned ancestor headers above the scrolled viewport plus the smooth push-up offset
 * (0..rowHeight) as the next sibling section enters the sticky boundary.
 */
export function computeStickyAncestors(
  rows: readonly TreeRow[],
  scrollTop: number,
  rowHeight: number,
  maxCount = 3,
): StickyAncestorsState {
  if (scrollTop <= 0 || rowHeight <= 0 || rows.length === 0) {
    return { rows: [], pushUpPx: 0 };
  }
  const firstIndex = Math.floor(scrollTop / rowHeight);
  if (firstIndex <= 0 || firstIndex >= rows.length) {
    return { rows: [], pushUpPx: 0 };
  }

  const first = rows[firstIndex];
  if (!first || first.ancestorPaths.length === 0) {
    return { rows: [], pushUpPx: 0 };
  }

  const needed = first.ancestorPaths.slice(-maxCount);
  const neededSet = new Set(needed);
  const byPath = new Map<string, TreeEntryRow>();
  for (let i = firstIndex - 1; i >= 0 && byPath.size < neededSet.size; i -= 1) {
    const candidate = rows[i];
    if (
      candidate?.type === "entry" &&
      candidate.kind === "directory" &&
      candidate.expanded &&
      neededSet.has(candidate.path)
    ) {
      byPath.set(candidate.path, candidate);
    }
  }
  const pinned: TreeEntryRow[] = [];
  for (const anc of needed) {
    const found = byPath.get(anc);
    if (found) pinned.push(found);
  }
  if (pinned.length === 0) return { rows: [], pushUpPx: 0 };

  // Compute push-up offset when the row directly beneath the sticky stack exits the bottom sticky folder.
  const bottomSticky = pinned.at(-1);
  let pushUpPx = 0;
  if (bottomSticky) {
    const boundaryIndex = firstIndex + pinned.length;
    const boundaryRow = rows[boundaryIndex];
    if (boundaryRow && !boundaryRow.ancestorPaths.includes(bottomSticky.path)) {
      const boundaryTop = boundaryIndex * rowHeight - scrollTop;
      const stickyBottom = pinned.length * rowHeight;
      if (boundaryTop < stickyBottom) {
        pushUpPx = Math.max(0, Math.min(rowHeight, stickyBottom - boundaryTop));
      }
    }
  }
  return { rows: pinned, pushUpPx };
}

/** Standard tree keyboard navigation across entry rows (supports compacted folder chains). */
export function navigateTree(
  rows: readonly TreeRow[],
  current: string | undefined,
  key: TreeNavigationKey,
): TreeNavigationAction {
  const entries = rows.filter((row): row is TreeEntryRow => row.type === "entry");
  if (entries.length === 0) return {};
  const index = entries.findIndex(
    (row) => row.path === current || (row.segments?.some((seg) => seg.path === current) ?? false),
  );
  const row = entries[index];
  if (key === "Home") return { focus: entries[0]?.path };
  if (key === "End") return { focus: entries.at(-1)?.path };
  if (!row) return { focus: entries[0]?.path };
  if (key === "ArrowDown") return { focus: entries[Math.min(index + 1, entries.length - 1)]?.path };
  if (key === "ArrowUp") return { focus: entries[Math.max(index - 1, 0)]?.path };
  if (key === "ArrowRight") {
    if (row.kind !== "directory") return {};
    if (!row.expanded) return { expand: row.path };
    const next = entries[index + 1];
    return next && next.depth > row.depth ? { focus: next.path } : {};
  }
  if (row.kind === "directory" && row.expanded) {
    return { collapse: row.segments?.[0]?.path ?? row.path };
  }
  const parent = row.ancestorPaths.at(-1) ?? parentOf(row.segments?.[0]?.path ?? row.path);
  return parent === "" ? {} : { focus: parent };
}

/** Visible paths between `from` and `to` inclusive for Shift-click selection. */
export function rangeBetween(rows: readonly TreeRow[], from: string, to: string): string[] {
  const entries = rows.filter((row): row is TreeEntryRow => row.type === "entry");
  const a = entries.findIndex((row) => row.path === from);
  const b = entries.findIndex((row) => row.path === to);
  if (a === -1 || b === -1) return [to];
  return entries.slice(Math.min(a, b), Math.max(a, b) + 1).map((row) => row.path);
}

/** Filters out paths nested inside another path in the same selection. */
export function topLevelPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => !paths.some((other) => other !== path && isInside(path, other)));
}

/** True when every path can legally move into `directory`. */
export function canMoveInto(paths: readonly string[], directory: string): boolean {
  return (
    paths.length > 0 &&
    paths.every((path) => !isSameOrInside(directory, path) && parentOf(path) !== directory)
  );
}

/** Target parent directory for creating or uploading entries given the active selection. */
export function targetDirectory(path: string | undefined, kind: EntryKind | undefined): string {
  if (path === undefined) return "";
  return kind === "directory" ? path : parentOf(path);
}

export interface FileTreeModelOptions {
  readonly preparedInput?: PreparedFileTreeInput;
  readonly paths?: readonly RawTreeEntry[];
  readonly snapshot?: IndexedTreeSnapshot;
  readonly initialExpanded?: readonly string[];
  readonly compactFolders?: boolean;
  readonly git?: FileTreeGitState;
}

export interface FileTreeStateSnapshot {
  readonly rows: readonly TreeRow[];
  readonly revision: number;
  readonly expanded: ReadonlySet<string>;
  readonly selected: ReadonlySet<string>;
  readonly focusedPath: string | undefined;
  readonly filter: string;
  readonly draft: TreeDraft | undefined;
  readonly focusModality: "pointer" | "keyboard";
  readonly compactFolders: boolean;
}

/**
 * Reactive, framework-neutral tree state engine implementing `Subscribable<FileTreeStateSnapshot>`.
 * Supports O(1) remount from `PreparedFileTreeInput`, indexed patches, optimistic mutations,
 * lazy loading states, multi-select, inline filter, and keyboard navigation.
 */
export class FileTreeModel implements Subscribable<FileTreeStateSnapshot> {
  readonly index: FileTreeIndex;
  private expanded: Set<string>;
  private selected: Set<string>;
  private selectionAnchor: string | undefined;
  private focusedPath: string | undefined;
  private filter = "";
  private draft: TreeDraft | undefined;
  private git: FileTreeGitState | undefined;
  private compactFolders: boolean;
  private focusModality: "pointer" | "keyboard" = "pointer";
  private listeners = new Set<() => void>();
  private snapshot: FileTreeStateSnapshot | null = null;

  constructor(options?: FileTreeModelOptions) {
    if (options?.preparedInput) {
      this.index = new FileTreeIndex(options.preparedInput);
    } else if (options?.snapshot) {
      this.index = FileTreeIndex.fromSnapshot(options.snapshot);
    } else if (options?.paths) {
      this.index = new FileTreeIndex(prepareFileTreeInput(options.paths));
    } else {
      this.index = new FileTreeIndex();
    }
    this.expanded = new Set(options?.initialExpanded ?? []);
    this.selected = new Set();
    this.compactFolders = options?.compactFolders ?? true;
    this.git = options?.git;
  }

  getSnapshot = (): FileTreeStateSnapshot => {
    if (this.snapshot) return this.snapshot;
    const rows = computeVisibleRows(this.index, this.expanded, this.draft, {
      compactFolders: this.compactFolders,
      filter: this.filter,
      git: this.git,
      selected: this.selected,
      focusedPath: this.focusedPath,
    });
    this.snapshot = {
      rows,
      revision: this.index.revision,
      expanded: this.expanded,
      selected: this.selected,
      focusedPath: this.focusedPath,
      filter: this.filter,
      draft: this.draft,
      focusModality: this.focusModality,
      compactFolders: this.compactFolders,
    };
    return this.snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit(): void {
    this.snapshot = null;
    for (const listener of this.listeners) listener();
  }

  setExpanded(path: string, open: boolean): void {
    const has = this.expanded.has(path);
    if (has === open) return;
    this.expanded = new Set(this.expanded);
    if (open) {
      this.expanded.add(path);
      for (const anc of ancestorsOf(path)) this.expanded.add(anc);
    } else {
      this.expanded.delete(path);
    }
    this.emit();
  }

  toggleExpanded(path: string): boolean {
    const next = !this.expanded.has(path);
    this.setExpanded(path, next);
    return next;
  }

  expandAllAncestors(path: string): void {
    const next = new Set(this.expanded);
    let changed = false;
    for (const anc of ancestorsOf(path)) {
      if (!next.has(anc)) {
        next.add(anc);
        changed = true;
      }
    }
    if (!changed) return;
    this.expanded = next;
    this.emit();
  }

  select(
    path: string,
    mode: "replace" | "toggle" | "range" = "replace",
    modality: "pointer" | "keyboard" = "pointer",
  ): void {
    this.focusModality = modality;
    this.focusedPath = path;
    if (mode === "replace") {
      this.selected = new Set([path]);
      this.selectionAnchor = path;
    } else if (mode === "toggle") {
      const next = new Set(this.selected);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      this.selected = next;
      this.selectionAnchor = path;
    } else {
      const anchor = this.selectionAnchor ?? path;
      const rows = this.getSnapshot().rows;
      this.selected = new Set(rangeBetween(rows, anchor, path));
    }
    this.emit();
  }

  setFocusedPath(path: string | undefined, modality: "pointer" | "keyboard" = "keyboard"): void {
    if (this.focusedPath === path && this.focusModality === modality) return;
    this.focusedPath = path;
    this.focusModality = modality;
    this.emit();
  }

  setFilter(next: string): void {
    if (this.filter === next) return;
    this.filter = next;
    this.emit();
  }

  setDraft(draft: TreeDraft | undefined): void {
    this.draft = draft;
    if (draft?.mode === "create" && draft.parent) {
      const next = new Set(this.expanded);
      next.add(draft.parent);
      for (const anc of ancestorsOf(draft.parent)) next.add(anc);
      this.expanded = next;
    }
    this.emit();
  }

  setGitState(git: FileTreeGitState | undefined): void {
    if (this.git === git) return;
    this.git = git;
    this.emit();
  }

  setCompactFolders(compact: boolean): void {
    if (this.compactFolders === compact) return;
    this.compactFolders = compact;
    this.emit();
  }

  replaceSnapshot(snapshot: IndexedTreeSnapshot): void {
    this.index.replaceSnapshot(snapshot);
    this.emit();
  }

  applyPatch(patch: IndexedTreePatch): PatchApplyResult {
    const result = this.index.applyPatch(patch);
    if (result.status === "applied") this.emit();
    return result;
  }

  notifyIndexChange(): void {
    this.emit();
  }
}
