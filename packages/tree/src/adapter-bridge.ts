import type { FileSystemAdapter } from "@shaulavo/workbench-core";
import type { FileTreeModel } from "./model";

export interface BoundFileTreeAdapter {
  /** Ensures a lazy directory is subscribed and loaded when expanded or retried. */
  ensureDirectoryLoaded(dirPath: string, options?: { readonly force?: boolean }): Promise<void>;
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

  function subscribeLazyDir(dirPath: string): void {
    const lazy = adapter.lazy;
    if (!lazy || lazyUnsubs.has(dirPath)) return;
    const stateSub = lazy.getDirectoryState(dirPath);
    model.index.setLazyDirectoryState(dirPath, stateSub.getSnapshot());
    model.notifyIndexChange();
    const unsub = stateSub.subscribe(() => {
      if (disposed) return;
      model.index.setLazyDirectoryState(dirPath, stateSub.getSnapshot());
      model.notifyIndexChange();
    });
    lazyUnsubs.set(dirPath, unsub);
  }

  async function ensureDirectoryLoaded(
    dirPath: string,
    options?: { readonly force?: boolean },
  ): Promise<void> {
    const lazy = adapter.lazy;
    if (!lazy || disposed) return;
    subscribeLazyDir(dirPath);
    const current = lazy.getDirectoryState(dirPath).getSnapshot();
    if (!options?.force && current.status !== "idle") return;
    await lazy.loadDirectory(dirPath, options);
  }

  if (adapter.lazy) {
    const lazy = adapter.lazy;
    subscribeLazyDir("");
    void ensureDirectoryLoaded("");
    for (const dir of model.getSnapshot().expanded) {
      subscribeLazyDir(dir);
      const current = lazy.getDirectoryState(dir).getSnapshot();
      if (current.status === "idle") void ensureDirectoryLoaded(dir);
    }

    cleanups.push(
      lazy.subscribeInvalidation((event) => {
        if (disposed) return;
        model.index.applyLazyInvalidation(event);
        model.notifyIndexChange();
        if (event.reset) {
          void ensureDirectoryLoaded("", { force: true });
          for (const dir of model.getSnapshot().expanded) {
            void ensureDirectoryLoaded(dir, { force: true });
          }
          return;
        }
        const expanded = model.getSnapshot().expanded;
        for (const dir of event.directories) {
          if (dir === "" || expanded.has(dir)) {
            void ensureDirectoryLoaded(dir, { force: true });
          }
        }
      }),
    );
  }

  return {
    ensureDirectoryLoaded,
    dispose() {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
      for (const unsub of lazyUnsubs.values()) unsub();
      lazyUnsubs.clear();
    },
  };
}
