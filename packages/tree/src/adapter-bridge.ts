import type { FileSystemAdapter, LazyInvalidationEvent } from "@shaulavo/workbench-core";
import type { FileTreeModel } from "./model";
import { normalizeTreePath } from "./paths";

export interface BoundFileTreeAdapter {
  /** Ensures a lazy directory is subscribed and loaded when expanded or retried. */
  ensureDirectoryLoaded(dirPath: string, options?: { readonly force?: boolean }): Promise<void>;
  /** True when a lazy directory was invalidated while collapsed and has not been reloaded yet. */
  isDirectoryStale(dirPath: string): boolean;
  /** Stops all snapshot, patch, lazy directory, invalidation, and git subscriptions. */
  dispose(): void;
}

/**
 * Binds a `FileTreeModel` to either Mode A (lazy per-directory `FileSystemAdapter.lazy`) or
 * Mode B (indexed snapshot + ordered patch stream `FileSystemAdapter.indexed`) plus optional Git
 * decorations. On patch revision gap or `reset`, automatically triggers `requestResync()`.
 */
export function bindFileSystemAdapter(
  model: FileTreeModel,
  adapter: FileSystemAdapter,
): BoundFileTreeAdapter {
  const cleanups: (() => void)[] = [];
  const lazyUnsubs = new Map<string, () => void>();
  const staleLazyDirs = new Set<string>();
  let handlingInvalidation = false;
  let wasFiltering = false;
  let filterListGen = 0;
  let disposed = false;

  if (adapter.git) {
    model.setGitState(adapter.git.getSnapshot());
    cleanups.push(
      adapter.git.subscribe(() => {
        if (!disposed) model.setGitState(adapter.git?.getSnapshot());
      }),
    );
  }

  if (adapter.indexed) {
    const indexed = adapter.indexed;
    const initial = indexed.snapshot.getSnapshot();
    if (initial) model.replaceSnapshot(initial);

    cleanups.push(
      indexed.snapshot.subscribe(() => {
        if (disposed) return;
        const next = indexed.snapshot.getSnapshot();
        if (next) model.replaceSnapshot(next);
      }),
    );

    cleanups.push(
      indexed.subscribePatches((patch) => {
        if (disposed) return;
        const result = model.applyPatch(patch);
        if (result.status === "resync-required") {
          void indexed.requestResync();
        }
      }),
    );
  }

  function pruneRetiredLazySubscriptions(parentDir: string): void {
    const prefix = parentDir === "" ? "" : `${parentDir}/`;
    for (const [subDir, unsub] of Array.from(lazyUnsubs.entries())) {
      if (subDir === "" || subDir === parentDir) continue;
      if (prefix && !subDir.startsWith(prefix)) continue;
      if (model.index.getConfirmedKind(subDir) !== "directory") {
        unsub();
        lazyUnsubs.delete(subDir);
        staleLazyDirs.delete(subDir);
      }
    }
  }

  function subscribeLazyDir(dirPath: string): void {
    const lazy = adapter.lazy;
    const normalized = normalizeTreePath(dirPath);
    if (!lazy || lazyUnsubs.has(normalized)) return;
    const stateSub = lazy.getDirectoryState(normalized);
    const applyState = (): void => {
      const nextState = stateSub.getSnapshot();
      model.index.setLazyDirectoryState(normalized, nextState);
      if (nextState.status === "loaded") pruneRetiredLazySubscriptions(normalized);
      model.notifyIndexChange();
    };
    const unsub = stateSub.subscribe(() => {
      if (disposed) return;
      applyState();
    });
    lazyUnsubs.set(normalized, unsub);
    applyState();
  }

  async function ensureDirectoryLoaded(
    dirPath: string,
    options?: { readonly force?: boolean },
  ): Promise<void> {
    const lazy = adapter.lazy;
    if (!lazy || disposed) return;
    const normalized = normalizeTreePath(dirPath);
    subscribeLazyDir(normalized);
    const wasStale = staleLazyDirs.delete(normalized);
    const force = Boolean(options?.force) || wasStale;
    const current = lazy.getDirectoryState(normalized).getSnapshot();
    if (!force && current.status !== "idle") return;
    await lazy.loadDirectory(normalized, force ? { force: true } : options);
  }

  function refreshFilterFiles(): void {
    if (disposed || !adapter.lazy) return;
    const isFiltering = model.getSnapshot().filter.trim().length > 0;
    if (!isFiltering) {
      filterListGen += 1;
      model.setFilterPaths(undefined);
      return;
    }
    const gen = ++filterListGen;
    void adapter
      .listFiles()
      .then((paths) => {
        if (disposed || gen !== filterListGen) return;
        if (model.getSnapshot().filter.trim().length === 0) return;
        model.setFilterPaths(paths);
      })
      .catch(() => {
        // Keep currently loaded entries filterable if workspace listing fails.
      });
  }

  function syncLazyFilterSubscription(): void {
    if (disposed) return;
    const isFiltering = model.getSnapshot().filter.trim().length > 0;
    if (isFiltering === wasFiltering) return;
    wasFiltering = isFiltering;
    refreshFilterFiles();
  }

  function syncExpandedLazyDirectories(): void {
    if (disposed || handlingInvalidation) return;
    syncLazyFilterSubscription();
    for (const dir of model.getSnapshot().expanded) {
      const normalized = normalizeTreePath(dir);
      if (!normalized || model.index.getConfirmedKind(normalized) !== "directory") continue;
      if (!lazyUnsubs.has(normalized) || staleLazyDirs.has(normalized)) {
        void ensureDirectoryLoaded(normalized);
      }
    }
  }

  function reloadInvalidatedLazyDirs(event: LazyInvalidationEvent): void {
    if (event.reset) {
      for (const dir of lazyUnsubs.keys()) staleLazyDirs.add(dir);
      staleLazyDirs.add("");
      void ensureDirectoryLoaded("", { force: true });
      for (const dir of model.getSnapshot().expanded) {
        void ensureDirectoryLoaded(dir, { force: true });
      }
      return;
    }
    const expanded = model.getSnapshot().expanded;
    for (const dir of event.directories) {
      const normalized = normalizeTreePath(dir);
      if (normalized === "" || expanded.has(normalized)) {
        void ensureDirectoryLoaded(normalized, { force: true });
      } else {
        staleLazyDirs.add(normalized);
      }
    }
  }

  function handleLazyInvalidation(event: LazyInvalidationEvent): void {
    if (disposed) return;
    handlingInvalidation = true;
    try {
      filterListGen += 1;
      model.setFilterPaths(undefined);
      model.index.applyLazyInvalidation(event);
      model.notifyIndexChange(
        event.moves.length > 0 || event.removed.length > 0
          ? { movedPaths: event.moves, removedPaths: event.removed }
          : undefined,
      );
      reloadInvalidatedLazyDirs(event);
    } finally {
      handlingInvalidation = false;
    }
    syncExpandedLazyDirectories();
    if (model.getSnapshot().filter.trim().length > 0) {
      refreshFilterFiles();
    }
  }

  if (adapter.lazy) {
    const lazy = adapter.lazy;
    subscribeLazyDir("");
    void ensureDirectoryLoaded("");
    for (const dir of model.getSnapshot().expanded) {
      subscribeLazyDir(dir);
      const current = lazy.getDirectoryState(normalizeTreePath(dir)).getSnapshot();
      if (current.status === "idle") void ensureDirectoryLoaded(dir);
    }

    syncLazyFilterSubscription();
    cleanups.push(model.subscribe(syncExpandedLazyDirectories));
    cleanups.push(lazy.subscribeInvalidation(handleLazyInvalidation));
  }

  return {
    ensureDirectoryLoaded,
    isDirectoryStale(dirPath) {
      return staleLazyDirs.has(normalizeTreePath(dirPath));
    },
    dispose() {
      disposed = true;
      filterListGen += 1;
      model.setFilterPaths(undefined);
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
      for (const unsub of lazyUnsubs.values()) unsub();
      lazyUnsubs.clear();
    },
  };
}
