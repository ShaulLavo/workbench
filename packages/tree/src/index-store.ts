import {
  isOptimisticTreeMutationConfirmed,
  type DirEntry,
  type DirectoryLoadState,
  type EntryKind,
  type IndexedTreePatch,
  type IndexedTreeSnapshot,
  type LazyInvalidationEvent,
  type OptimisticTreeMutation,
} from "@shaulavo/workbench-core";
import { ancestorsOf, baseName, compareDirEntries, joinPath, normalizeTreePath, parentOf } from "./paths";

export type RawTreeEntry = string | { readonly path: string; readonly kind: EntryKind };

export interface PrepareFileTreeOptions {
  readonly revision?: number;
  readonly loadedDirectoryPaths?: ReadonlySet<string>;
}

/** Immutable pre-indexed tree representation enabling O(1) model remounts at 50k+ paths. */
export interface PreparedFileTreeInput {
  readonly revision: number;
  readonly childrenByDir: ReadonlyMap<string, readonly DirEntry[]>;
  readonly kindByPath: ReadonlyMap<string, EntryKind>;
  readonly loadedDirectoryPaths: ReadonlySet<string>;
  readonly entryCount: number;
}

export interface PendingOptimisticEntry {
  readonly id: string;
  readonly mutation: OptimisticTreeMutation;
  readonly inFlight?: boolean;
}

export type PatchApplyResult =
  | { readonly status: "applied"; readonly revision: number }
  | { readonly status: "resync-required"; readonly reason: "reset" | "revision-gap" };

interface MutableLayer {
  readonly children: Map<string, DirEntry[]>;
  readonly kinds: Map<string, EntryKind>;
  readonly loaded: Set<string>;
}

function ensureDirSlot(childrenByDir: Map<string, DirEntry[]>, dirPath: string): DirEntry[] {
  let list = childrenByDir.get(dirPath);
  if (!list) {
    list = [];
    childrenByDir.set(dirPath, list);
  }
  return list;
}

function insertPathIntoMaps(
  childrenByDir: Map<string, DirEntry[]>,
  kindByPath: Map<string, EntryKind>,
  rawPath: string,
  rawKind: EntryKind,
): void {
  const path = normalizeTreePath(rawPath);
  if (!path) return;

  const existing = kindByPath.get(path);
  if (existing === rawKind) return;
  if (existing && existing !== rawKind) {
    if (existing === "directory") return;
    kindByPath.set(path, "directory");
    const parent = parentOf(path);
    const list = ensureDirSlot(childrenByDir, parent);
    const name = baseName(path);
    const idx = list.findIndex((item) => item.name === name);
    if (idx !== -1) list[idx] = { name, kind: "directory" };
    ensureDirSlot(childrenByDir, path);
    return;
  }

  kindByPath.set(path, rawKind);
  if (rawKind === "directory") ensureDirSlot(childrenByDir, path);

  let childPath = path;
  let childKind: EntryKind = rawKind;
  while (true) {
    const parent = parentOf(childPath);
    const list = ensureDirSlot(childrenByDir, parent);
    list.push({ name: baseName(childPath), kind: childKind });
    if (parent === "") break;
    if (kindByPath.get(parent) === "directory") break;
    kindByPath.set(parent, "directory");
    ensureDirSlot(childrenByDir, parent);
    childPath = parent;
    childKind = "directory";
  }
}

/**
 * Builds an immutable, pre-sorted `PreparedFileTreeInput` in a single linear pass over paths or
 * snapshot entries. Preserves explicit empty directories (trailing `/` or `kind: "directory"`).
 */
export function prepareFileTreeInput(
  entries: readonly RawTreeEntry[],
  options?: PrepareFileTreeOptions,
): PreparedFileTreeInput {
  const childrenByDir = new Map<string, DirEntry[]>([["", []]]);
  const kindByPath = new Map<string, EntryKind>();

  for (let i = 0; i < entries.length; i += 1) {
    const item = entries[i];
    if (item === undefined) continue;
    if (typeof item === "string") {
      const isDir = item.endsWith("/");
      insertPathIntoMaps(childrenByDir, kindByPath, item, isDir ? "directory" : "file");
    } else {
      insertPathIntoMaps(childrenByDir, kindByPath, item.path, item.kind);
    }
  }

  for (const list of childrenByDir.values()) {
    if (list.length > 1) list.sort(compareDirEntries);
  }

  const loaded = options?.loadedDirectoryPaths ?? new Set<string>(childrenByDir.keys());
  return {
    revision: options?.revision ?? 0,
    childrenByDir,
    kindByPath,
    loadedDirectoryPaths: loaded,
    entryCount: kindByPath.size,
  };
}

function insertSorted(list: DirEntry[], entry: DirEntry): void {
  const existingIdx = list.findIndex((item) => item.name === entry.name);
  if (existingIdx !== -1) {
    if (list[existingIdx]?.kind === entry.kind) return;
    list[existingIdx] = entry;
    list.sort(compareDirEntries);
    return;
  }
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midEntry = list[mid];
    if (midEntry && compareDirEntries(midEntry, entry) < 0) lo = mid + 1;
    else hi = mid;
  }
  list.splice(lo, 0, entry);
}

function removeFromDir(list: DirEntry[] | undefined, name: string): void {
  if (!list) return;
  const idx = list.findIndex((item) => item.name === name);
  if (idx !== -1) list.splice(idx, 1);
}

function cloneLayer(
  childrenSrc: ReadonlyMap<string, readonly DirEntry[]>,
  kindsSrc: ReadonlyMap<string, EntryKind>,
  loadedSrc: ReadonlySet<string>,
): MutableLayer {
  const children = new Map<string, DirEntry[]>();
  for (const [dir, list] of childrenSrc) {
    children.set(dir, list.slice());
  }
  return {
    children,
    kinds: new Map(kindsSrc),
    loaded: new Set(loadedSrc),
  };
}

function createPathInLayer(layer: MutableLayer, path: string, kind: EntryKind): void {
  if (!path) return;
  layer.kinds.set(path, kind);
  if (kind === "directory") {
    ensureDirSlot(layer.children, path);
    layer.loaded.add(path);
  }
  let childPath = path;
  let childKind: EntryKind = kind;
  while (true) {
    const parent = parentOf(childPath);
    const list = ensureDirSlot(layer.children, parent);
    insertSorted(list, { name: baseName(childPath), kind: childKind });
    if (parent === "") break;
    if (layer.kinds.get(parent) === "directory") break;
    layer.kinds.set(parent, "directory");
    ensureDirSlot(layer.children, parent);
    childPath = parent;
    childKind = "directory";
  }
}

function deleteSubtreeInLayer(layer: MutableLayer, path: string): void {
  if (!path) return;
  const kind = layer.kinds.get(path);
  removeFromDir(layer.children.get(parentOf(path)), baseName(path));
  layer.kinds.delete(path);
  layer.loaded.delete(path);
  if (kind !== "directory" && !layer.children.has(path)) return;

  const stack: string[] = [path];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    const entries = layer.children.get(current);
    layer.children.delete(current);
    layer.loaded.delete(current);
    if (!entries) continue;
    for (const entry of entries) {
      const child = joinPath(current, entry.name);
      layer.kinds.delete(child);
      if (entry.kind === "directory") stack.push(child);
    }
  }
}

function collectSubtreeFromLayer(
  layer: MutableLayer,
  rootPath: string,
): { readonly rel: string; readonly kind: EntryKind }[] {
  const entries: { readonly rel: string; readonly kind: EntryKind }[] = [];
  const rootKind = layer.kinds.get(rootPath);
  if (!rootKind) return entries;
  if (rootKind === "file") return [{ rel: "", kind: "file" }];

  entries.push({ rel: "", kind: "directory" });
  const stack: string[] = [rootPath];
  const prefixLen = rootPath.length + 1;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    for (const child of layer.children.get(current) ?? []) {
      const childPath = joinPath(current, child.name);
      entries.push({ rel: childPath.slice(prefixLen), kind: child.kind });
      if (child.kind === "directory") stack.push(childPath);
    }
  }
  return entries;
}

function patchTouchesPath(patch: IndexedTreePatch, targetPath: string): boolean {
  const canonical = normalizeTreePath(targetPath);
  if (patch.kind === "reset") return true;
  if (patch.kind === "create" || patch.kind === "delete") {
    const p = normalizeTreePath(patch.path);
    return p === canonical || canonical.startsWith(`${p}/`);
  }
  if (patch.kind === "duplicate") {
    const to = normalizeTreePath(patch.to);
    return to === canonical || canonical.startsWith(`${to}/`);
  }
  return patch.moves.some((move) => {
    const from = normalizeTreePath(move.from);
    const to = normalizeTreePath(move.to);
    return (
      from === canonical ||
      to === canonical ||
      canonical.startsWith(`${from}/`) ||
      canonical.startsWith(`${to}/`)
    );
  });
}

function isOptimisticConfirmedByPatch(
  confirmedKinds: ReadonlyMap<string, EntryKind>,
  patch: IndexedTreePatch,
  mutation: OptimisticTreeMutation,
): boolean {
  if (mutation.kind === "create") {
    const target = normalizeTreePath(mutation.path);
    return confirmedKinds.has(target);
  }
  if (mutation.kind === "delete") {
    const target = normalizeTreePath(mutation.path);
    return !confirmedKinds.has(target) && patchTouchesPath(patch, target);
  }
  if (mutation.kind === "duplicate") {
    const to = normalizeTreePath(mutation.to);
    return confirmedKinds.has(to);
  }
  return mutation.moves.every((move) => {
    const from = normalizeTreePath(move.from);
    const to = normalizeTreePath(move.to);
    return !confirmedKinds.has(from) && confirmedKinds.has(to);
  });
}

function applyMutationToLayer(layer: MutableLayer, mutation: OptimisticTreeMutation): void {
  if (mutation.kind === "create") {
    createPathInLayer(layer, normalizeTreePath(mutation.path), mutation.entryKind);
    return;
  }
  if (mutation.kind === "delete") {
    deleteSubtreeInLayer(layer, normalizeTreePath(mutation.path));
    return;
  }
  if (mutation.kind === "duplicate") {
    const from = normalizeTreePath(mutation.from);
    const to = normalizeTreePath(mutation.to);
    if (!from || !to || from === to) return;
    const subtree = collectSubtreeFromLayer(layer, from);
    if (subtree.length === 0) {
      createPathInLayer(layer, to, mutation.entryKind);
      return;
    }
    for (const item of subtree) {
      createPathInLayer(layer, item.rel ? `${to}/${item.rel}` : to, item.kind);
    }
    return;
  }
  for (const move of mutation.moves) {
    const from = normalizeTreePath(move.from);
    const to = normalizeTreePath(move.to);
    if (!from || !to || from === to) continue;
    const subtree = collectSubtreeFromLayer(layer, from);
    deleteSubtreeInLayer(layer, from);
    if (subtree.length === 0) {
      createPathInLayer(layer, to, move.entryKind);
      continue;
    }
    for (const item of subtree) {
      createPathInLayer(layer, item.rel ? `${to}/${item.rel}` : to, item.kind);
    }
  }
}

/**
 * Clean-room MIT tree index keeping confirmed state strictly separated from pending optimistic
 * overlays so concurrent confirmed patches survive optimistic rollbacks without loss.
 */
export class FileTreeIndex {
  private base: PreparedFileTreeInput;
  private confirmedOverlay: MutableLayer | null = null;
  private optimisticOverlay: MutableLayer | null = null;
  private readonly lazyStates = new Map<string, DirectoryLoadState>();
  private pendingOptimistic: PendingOptimisticEntry[] = [];
  private confirmedSnapshotCache: IndexedTreeSnapshot | null = null;

  constructor(prepared?: PreparedFileTreeInput) {
    this.base = prepared ?? prepareFileTreeInput([]);
  }

  static fromPaths(paths: readonly RawTreeEntry[], options?: PrepareFileTreeOptions): FileTreeIndex {
    return new FileTreeIndex(prepareFileTreeInput(paths, options));
  }

  static fromSnapshot(snapshot: IndexedTreeSnapshot): FileTreeIndex {
    return new FileTreeIndex(
      prepareFileTreeInput(snapshot.entries, {
        revision: snapshot.revision,
        loadedDirectoryPaths: snapshot.loadedDirectoryPaths,
      }),
    );
  }

  get revision(): number {
    return this.base.revision;
  }

  get entryCount(): number {
    return this.activeKinds().size;
  }

  getPendingOptimistic(): readonly PendingOptimisticEntry[] {
    return this.pendingOptimistic;
  }

  private confirmedChildren(): ReadonlyMap<string, readonly DirEntry[]> {
    return this.confirmedOverlay?.children ?? this.base.childrenByDir;
  }

  private confirmedKinds(): ReadonlyMap<string, EntryKind> {
    return this.confirmedOverlay?.kinds ?? this.base.kindByPath;
  }

  private confirmedLoaded(): ReadonlySet<string> {
    return this.confirmedOverlay?.loaded ?? this.base.loadedDirectoryPaths;
  }

  private activeChildren(): ReadonlyMap<string, readonly DirEntry[]> {
    return this.optimisticOverlay?.children ?? this.confirmedChildren();
  }

  private activeKinds(): ReadonlyMap<string, EntryKind> {
    return this.optimisticOverlay?.kinds ?? this.confirmedKinds();
  }

  private activeLoaded(): ReadonlySet<string> {
    return this.optimisticOverlay?.loaded ?? this.confirmedLoaded();
  }

  private ensureConfirmedMutable(): MutableLayer {
    this.confirmedSnapshotCache = null;
    if (!this.confirmedOverlay) {
      this.confirmedOverlay = cloneLayer(
        this.base.childrenByDir,
        this.base.kindByPath,
        this.base.loadedDirectoryPaths,
      );
    }
    return this.confirmedOverlay;
  }

  private rebuildOptimisticOverlay(): void {
    if (this.pendingOptimistic.length === 0) {
      this.optimisticOverlay = null;
      return;
    }
    const layer = cloneLayer(this.confirmedChildren(), this.confirmedKinds(), this.confirmedLoaded());
    for (const entry of this.pendingOptimistic) {
      applyMutationToLayer(layer, entry.mutation);
    }
    this.optimisticOverlay = layer;
  }

  getChildren(dirPath: string): readonly DirEntry[] {
    return this.activeChildren().get(dirPath) ?? [];
  }

  getKind(treePath: string): EntryKind | undefined {
    return this.activeKinds().get(treePath);
  }

  getConfirmedKind(treePath: string): EntryKind | undefined {
    return this.confirmedKinds().get(treePath);
  }

  hasPath(treePath: string): boolean {
    return this.activeKinds().has(treePath);
  }

  isDirectoryLoaded(dirPath: string): boolean {
    if (dirPath === "") return true;
    const lazy = this.lazyStates.get(dirPath);
    if (lazy) return lazy.status === "loaded";
    return this.activeLoaded().has(dirPath);
  }

  getDirectoryLoadState(dirPath: string): DirectoryLoadState {
    const lazy = this.lazyStates.get(dirPath);
    if (lazy) return lazy;
    if (dirPath === "" || this.activeLoaded().has(dirPath)) {
      return { status: "loaded", entries: this.getChildren(dirPath) };
    }
    return { status: "idle" };
  }

  /** Replaces confirmed state with a pre-built `PreparedFileTreeInput` in O(1) without re-indexing. */
  replacePreparedInput(prepared: PreparedFileTreeInput): void {
    this.base = prepared;
    this.confirmedOverlay = null;
    this.confirmedSnapshotCache = null;
    if (this.pendingOptimistic.length > 0) {
      const confirmed = this.toConfirmedSnapshot();
      const confirmedKinds = this.confirmedKinds();
      this.pendingOptimistic = this.pendingOptimistic.filter(
        (entry) =>
          !(entry.inFlight
            ? isOptimisticConfirmedByPatch(
                confirmedKinds,
                { kind: "reset", nextRevision: prepared.revision },
                entry.mutation,
              )
            : isOptimisticTreeMutationConfirmed(confirmed, entry.mutation)),
      );
    }
    this.rebuildOptimisticOverlay();
  }

  /** Replaces confirmed state with a new indexed snapshot and settles matching optimistic mutations. */
  replaceSnapshot(snapshot: IndexedTreeSnapshot): void {
    this.base = prepareFileTreeInput(snapshot.entries, {
      revision: snapshot.revision,
      loadedDirectoryPaths: snapshot.loadedDirectoryPaths,
    });
    this.confirmedOverlay = null;
    this.confirmedSnapshotCache = snapshot;
    if (this.pendingOptimistic.length > 0) {
      const confirmedKinds = this.confirmedKinds();
      this.pendingOptimistic = this.pendingOptimistic.filter(
        (entry) =>
          !(entry.inFlight
            ? isOptimisticConfirmedByPatch(
                confirmedKinds,
                { kind: "reset", nextRevision: snapshot.revision },
                entry.mutation,
              )
            : isOptimisticTreeMutationConfirmed(snapshot, entry.mutation)),
      );
    }
    this.rebuildOptimisticOverlay();
  }

  /** Applies an ordered incremental patch to confirmed state; returns `resync-required` on `reset` or gap. */
  applyPatch(patch: IndexedTreePatch): PatchApplyResult {
    if (patch.kind === "reset") {
      return { status: "resync-required", reason: "reset" };
    }
    if (patch.baseRevision !== this.base.revision) {
      return { status: "resync-required", reason: "revision-gap" };
    }
    const layer = this.ensureConfirmedMutable();
    if (patch.kind === "create") {
      applyMutationToLayer(layer, { kind: "create", path: patch.path, entryKind: patch.entryKind });
    } else if (patch.kind === "move") {
      applyMutationToLayer(layer, { kind: "move", moves: patch.moves });
    } else if (patch.kind === "duplicate") {
      applyMutationToLayer(layer, {
        kind: "duplicate",
        from: patch.from,
        to: patch.to,
        entryKind: patch.entryKind,
      });
    } else {
      applyMutationToLayer(layer, { kind: "delete", path: patch.path });
    }
    this.base = { ...this.base, revision: patch.nextRevision };
    if (this.pendingOptimistic.length > 0) {
      const confirmedKinds = this.confirmedKinds();
      this.pendingOptimistic = this.pendingOptimistic.filter(
        (entry) => !isOptimisticConfirmedByPatch(confirmedKinds, patch, entry.mutation),
      );
    }
    this.rebuildOptimisticOverlay();
    return { status: "applied", revision: patch.nextRevision };
  }

  /** Applies an optimistic local mutation on top of confirmed state until settled or rolled back. */
  applyOptimistic(
    id: string,
    mutation: OptimisticTreeMutation,
    options?: { readonly inFlight?: boolean },
  ): void {
    this.pendingOptimistic = this.pendingOptimistic
      .filter((item) => item.id !== id)
      .concat([{ id, mutation, inFlight: options?.inFlight ?? false }]);
    this.rebuildOptimisticOverlay();
  }

  /** Marks an in-flight optimistic mutation as completed so unloaded-parent snapshots can settle it. */
  settleOptimistic(id: string): void {
    let changed = false;
    this.pendingOptimistic = this.pendingOptimistic.map((item) => {
      if (item.id !== id || !item.inFlight) return item;
      changed = true;
      return { id: item.id, mutation: item.mutation, inFlight: false };
    });
    if (!changed) return;
    const confirmed = this.toConfirmedSnapshot();
    this.pendingOptimistic = this.pendingOptimistic.filter(
      (entry) => entry.inFlight || !isOptimisticTreeMutationConfirmed(confirmed, entry.mutation),
    );
    this.rebuildOptimisticOverlay();
  }

  /** Rolls back one rejected optimistic mutation while preserving all confirmed patches and other pending intents. */
  rollbackOptimistic(id: string): void {
    this.pendingOptimistic = this.pendingOptimistic.filter((item) => item.id !== id);
    this.rebuildOptimisticOverlay();
  }

  private isStaleLazyDirectoryTarget(normalized: string): boolean {
    if (normalized === "") return false;
    const kinds = this.confirmedKinds();
    const loaded = this.confirmedLoaded();
    const currentKind = kinds.get(normalized);
    if (currentKind && currentKind !== "directory") return true;

    const chain = ancestorsOf(normalized).concat([normalized]);
    for (let i = 0; i < chain.length; i += 1) {
      const segmentPath = chain[i];
      if (!segmentPath) continue;
      const segKind = kinds.get(segmentPath);
      if (segKind && segKind !== "directory") return true;
      const parentPath = i === 0 ? "" : (chain[i - 1] ?? "");
      if (loaded.has(parentPath) && segKind !== "directory") return true;
    }
    return false;
  }

  /** Updates a single directory's lazy load state (Sprockt lazy mode). */
  setLazyDirectoryState(dirPath: string, state: DirectoryLoadState): void {
    const normalized = normalizeTreePath(dirPath);
    if (this.isStaleLazyDirectoryTarget(normalized)) return;
    this.lazyStates.set(normalized, state);
    if (state.status !== "loaded") return;

    const layer = this.ensureConfirmedMutable();
    const previous = layer.children.get(normalized) ?? [];
    const nextKindByName = new Map(state.entries.map((entry) => [entry.name, entry.kind]));

    for (const old of previous) {
      const nextKind = nextKindByName.get(old.name);
      if (nextKind === undefined || (old.kind === "directory" && nextKind !== "directory")) {
        const oldPath = joinPath(normalized, old.name);
        deleteSubtreeInLayer(layer, oldPath);
        for (const key of Array.from(this.lazyStates.keys())) {
          if (key === oldPath || key.startsWith(`${oldPath}/`)) {
            this.lazyStates.delete(key);
          }
        }
      }
    }

    const sorted = state.entries.toSorted(compareDirEntries);
    layer.children.set(normalized, sorted);
    layer.loaded.add(normalized);
    if (normalized) layer.kinds.set(normalized, "directory");
    for (const entry of sorted) {
      const childPath = joinPath(normalized, entry.name);
      layer.kinds.set(childPath, entry.kind);
      if (entry.kind === "directory" && !layer.children.has(childPath)) {
        layer.children.set(childPath, []);
      }
    }
    if (this.pendingOptimistic.length > 0) {
      const confirmed = this.toConfirmedSnapshot();
      this.pendingOptimistic = this.pendingOptimistic.filter(
        (entry) => entry.inFlight || !isOptimisticTreeMutationConfirmed(confirmed, entry.mutation),
      );
    }
    this.rebuildOptimisticOverlay();
  }

  /** Handles lazy invalidation events by clearing stale directory caches and removed paths. */
  applyLazyInvalidation(event: LazyInvalidationEvent): void {
    if (event.reset) {
      this.lazyStates.clear();
      this.base = prepareFileTreeInput([]);
      this.confirmedOverlay = null;
      this.confirmedSnapshotCache = null;
      this.rebuildOptimisticOverlay();
      return;
    }
    const layer = this.ensureConfirmedMutable();
    for (const removed of event.removed) {
      deleteSubtreeInLayer(layer, normalizeTreePath(removed));
    }
    for (const dir of event.directories) {
      const normalized = normalizeTreePath(dir);
      this.lazyStates.delete(normalized);
      layer.loaded.delete(normalized);
    }
    this.rebuildOptimisticOverlay();
  }

  toConfirmedSnapshot(): IndexedTreeSnapshot {
    if (this.confirmedSnapshotCache) return this.confirmedSnapshotCache;
    const entries: { readonly path: string; readonly kind: EntryKind }[] = [];
    for (const [path, kind] of this.confirmedKinds()) {
      entries.push({ path, kind });
    }
    this.confirmedSnapshotCache = {
      revision: this.base.revision,
      entries,
      loadedDirectoryPaths: this.confirmedLoaded(),
    };
    return this.confirmedSnapshotCache;
  }
}
