import type {
  DirectoryLoadState,
  FileSystemAdapter,
  FileTreeGitState,
  IndexedTreePatch,
  IndexedTreeSnapshot,
  LazyInvalidationEvent,
  Subscribable,
} from "@shaulavo/workbench-core";
import { describe, expect, it, vi } from "vitest";
import {
  bindFileSystemAdapter,
  canMoveInto,
  computeStickyAncestors,
  computeVisibleRows,
  FileTreeIndex,
  FileTreeModel,
  navigateTree,
  prepareFileTreeInput,
  renameSelection,
  splitFilename,
  topLevelPaths,
  validateEntryName,
  type TreeEntryRow,
} from "../index";

function createSubscribable<T>(initial: T): Subscribable<T> & { set(next: T): void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next: T) {
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("@shaulavo/workbench-tree engine", () => {
  it("prepares deterministic sorted trees, preserves empty directories, and remounts in O(1)", () => {
    const prepared = prepareFileTreeInput([
      "src/z.ts",
      "src/a.ts",
      "empty-dir/",
      "README.md",
      "src/components/Button.tsx",
    ]);

    expect(prepared.entryCount).toBe(7);
    expect(prepared.childrenByDir.get("")?.map((e) => `${e.kind}:${e.name}`)).toEqual([
      "directory:empty-dir",
      "directory:src",
      "file:README.md",
    ]);
    expect(prepared.childrenByDir.get("empty-dir")).toEqual([]);

    const modelA = new FileTreeModel({ preparedInput: prepared, initialExpanded: ["src"] });
    const modelB = new FileTreeModel({ preparedInput: prepared, initialExpanded: ["src"] });
    expect(modelA.getSnapshot().rows.map((r) => r.key)).toEqual(modelB.getSnapshot().rows.map((r) => r.key));
  });

  it("applies ordered indexed patches, detects revision gaps/resets, and isolates optimistic rollbacks", () => {
    const index = FileTreeIndex.fromSnapshot({
      revision: 1,
      entries: [
        { path: "src", kind: "directory" },
        { path: "src/index.ts", kind: "file" },
      ],
      loadedDirectoryPaths: new Set(["", "src"]),
    });

    // Apply an optimistic create alongside a concurrent confirmed server patch.
    index.applyOptimistic("opt-1", { kind: "create", path: "draft.ts", entryKind: "file" });
    expect(index.hasPath("draft.ts")).toBe(true);

    const patchResult = index.applyPatch({
      kind: "create",
      baseRevision: 1,
      nextRevision: 2,
      path: "src/server.ts",
      entryKind: "file",
    });
    expect(patchResult).toEqual({ status: "applied", revision: 2 });
    expect(index.getPendingOptimistic()).toHaveLength(1);

    // Roll back the failed optimistic mutation: confirmed server.ts MUST survive.
    index.rollbackOptimistic("opt-1");
    expect(index.hasPath("draft.ts")).toBe(false);
    expect(index.hasPath("src/server.ts")).toBe(true);

    // Root-level create settles once confirmed patch arrives.
    index.applyOptimistic("opt-2", { kind: "create", path: "notes.md", entryKind: "file" });
    expect(index.getPendingOptimistic()).toHaveLength(1);
    index.applyPatch({
      kind: "create",
      baseRevision: 2,
      nextRevision: 3,
      path: "notes.md",
      entryKind: "file",
    });
    expect(index.getPendingOptimistic()).toHaveLength(0);
    expect(index.hasPath("notes.md")).toBe(true);

    // Out-of-order revision gap and reset both demand resync.
    expect(
      index.applyPatch({
        kind: "delete",
        baseRevision: 99,
        nextRevision: 100,
        path: "notes.md",
      }),
    ).toEqual({ status: "resync-required", reason: "revision-gap" });
    expect(index.applyPatch({ kind: "reset", nextRevision: 101 })).toEqual({
      status: "resync-required",
      reason: "reset",
    });
  });

  it("compacts single-child folder chains and uncompacts when renaming or creating inside", () => {
    const index = FileTreeIndex.fromPaths(["src/features/editor/App.tsx", "README.md"]);
    const expanded = new Set(["src", "src/features", "src/features/editor"]);

    const compacted = computeVisibleRows(index, expanded);
    const first = compacted[0] as TreeEntryRow;
    expect(first.name).toBe("src/features/editor");
    expect(first.segments?.map((s) => s.path)).toEqual(["src", "src/features", "src/features/editor"]);

    // Renaming middle segment pauses compaction before that segment.
    const duringRename = computeVisibleRows(index, expanded, {
      mode: "rename",
      path: "src/features",
    });
    const entryNames = duringRename
      .filter((r): r is TreeEntryRow => r.type === "entry")
      .map((r) => `${r.name}${r.editing ? "*" : ""}`);
    expect(entryNames).toEqual(["src", "features*", "editor", "App.tsx", "README.md"]);
  });

  it("filters matching files, keeps ancestor context muted, and excludes ignored directories", () => {
    const index = FileTreeIndex.fromPaths(["src/App.tsx", "node_modules/pkg/App.tsx", "docs/guide.md"]);
    const git: FileTreeGitState = {
      statusByPath: new Map([["src/App.tsx", "modified"]]),
      directoriesWithChanges: new Set(["src"]),
      ignoredDirectories: new Set(["node_modules"]),
    };

    const rows = computeVisibleRows(index, new Set(), undefined, { filter: "app", git });
    const entries = rows.filter((r): r is TreeEntryRow => r.type === "entry");
    expect(entries.map((e) => e.path)).toEqual(["src", "src/App.tsx"]);
    expect(entries[0]?.contextOnly).toBe(true);
    expect(entries[1]?.contextOnly).toBeUndefined();
    expect(entries[1]?.gitStatus).toBe("modified");
    expect(entries[0]?.hasChangedDescendant).toBe(true);
  });

  it("computes sticky ancestors and boundary push-up offset smoothly", () => {
    const index = FileTreeIndex.fromPaths(["alpha/a1.ts", "alpha/a2.ts", "alpha/a3.ts", "beta/b1.ts"]);
    const rows = computeVisibleRows(index, new Set(["alpha", "beta"]));
    // Rows: 0:alpha, 1:alpha/a1.ts, 2:alpha/a2.ts, 3:alpha/a3.ts, 4:beta, 5:beta/b1.ts
    const mid = computeStickyAncestors(rows, 26, 26, 3);
    expect(mid.rows.map((r) => r.path)).toEqual(["alpha"]);
    expect(mid.pushUpPx).toBe(0);

    // At scrollTop = 90 (firstIndex = 3 -> alpha/a3.ts), boundaryIndex = 4 (beta) starts at 4*26 - 90 = 14px (< 26px).
    const pushing = computeStickyAncestors(rows, 90, 26, 3);
    expect(pushing.rows.map((r) => r.path)).toEqual(["alpha"]);
    expect(pushing.pushUpPx).toBe(12);
  });

  it("assigns contiguous multi-select pill edges and supports keyboard navigation", () => {
    const model = new FileTreeModel({
      paths: ["a.ts", "b.ts", "c.ts", "d.ts"],
    });
    model.select("a.ts", "replace", "pointer");
    model.select("c.ts", "range", "pointer");

    const entries = model.getSnapshot().rows as readonly TreeEntryRow[];
    expect(entries.map((r) => r.selectionEdge)).toEqual(["start", "middle", "end", undefined]);

    expect(navigateTree(entries, "a.ts", "ArrowDown")).toEqual({ focus: "b.ts" });
    expect(navigateTree(entries, "c.ts", "End")).toEqual({ focus: "d.ts" });
    expect(navigateTree(entries, "c.ts", "Home")).toEqual({ focus: "a.ts" });
  });

  it("binds indexed adapter patches, triggers resync on revision gap, and binds lazy retry/invalidation", async () => {
    const snapshot = createSubscribable<IndexedTreeSnapshot | undefined>({
      revision: 1,
      entries: [{ path: "src/index.ts", kind: "file" }],
      loadedDirectoryPaths: new Set(["", "src"]),
    });
    const patchListeners = new Set<(patch: IndexedTreePatch) => void>();
    const requestResync = vi.fn(async () => {
      snapshot.set({
        revision: 5,
        entries: [{ path: "src/resynced.ts", kind: "file" }],
        loadedDirectoryPaths: new Set(["", "src"]),
      });
    });

    const indexedAdapter: FileSystemAdapter = {
      workspaceId: "test-indexed",
      writable: createSubscribable(true),
      indexed: {
        snapshot,
        subscribePatches(listener) {
          patchListeners.add(listener);
          return () => patchListeners.delete(listener);
        },
        requestResync,
      },
      listFiles: async () => [],
      readText: async () => "",
      createFile: async () => {},
      createDirectory: async () => {},
      move: async () => {},
      remove: async () => {},
    };

    const indexedModel = new FileTreeModel();
    const boundIndexed = bindFileSystemAdapter(indexedModel, indexedAdapter);
    expect(indexedModel.index.hasPath("src/index.ts")).toBe(true);

    for (const listener of patchListeners) {
      listener({ kind: "create", baseRevision: 4, nextRevision: 5, path: "gap.ts", entryKind: "file" });
    }
    expect(requestResync).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(indexedModel.index.hasPath("src/resynced.ts")).toBe(true);
    boundIndexed.dispose();

    // Lazy adapter error -> retry -> loaded + invalidation
    const rootDir = createSubscribable<DirectoryLoadState>({
      status: "loaded",
      entries: [{ name: "broken", kind: "directory" }],
    });
    const brokenDir = createSubscribable<DirectoryLoadState>({ status: "idle" });
    const invListeners = new Set<(event: LazyInvalidationEvent) => void>();
    let attempts = 0;

    const lazyAdapter: FileSystemAdapter = {
      workspaceId: "test-lazy",
      writable: createSubscribable(true),
      lazy: {
        getDirectoryState: (dir) => (dir === "" ? rootDir : brokenDir),
        async loadDirectory(dir) {
          if (dir !== "broken") return;
          attempts += 1;
          if (attempts === 1) {
            brokenDir.set({ status: "error", message: "Permission denied", retryable: true });
          } else {
            brokenDir.set({ status: "loaded", entries: [{ name: "ok.ts", kind: "file" }] });
          }
        },
        subscribeInvalidation(listener) {
          invListeners.add(listener);
          return () => invListeners.delete(listener);
        },
      },
      listFiles: async () => [],
      readText: async () => "",
      createFile: async () => {},
      createDirectory: async () => {},
      move: async () => {},
      remove: async () => {},
    };

    const lazyModel = new FileTreeModel({ initialExpanded: ["broken"] });
    const boundLazy = bindFileSystemAdapter(lazyModel, lazyAdapter);
    await boundLazy.ensureDirectoryLoaded("broken");
    expect(lazyModel.getSnapshot().rows.some((r) => r.type === "error" && r.retryable)).toBe(true);

    await boundLazy.ensureDirectoryLoaded("broken", { force: true });
    expect(lazyModel.index.hasPath("broken/ok.ts")).toBe(true);
    boundLazy.dispose();
  });

  it("handles path helpers, compound extension splits, rename selection, and move validation", () => {
    expect(splitFilename("App.test.tsx")).toEqual({ stem: "App", ext: ".test.tsx" });
    expect(splitFilename("index.d.ts")).toEqual({ stem: "index", ext: ".d.ts" });
    expect(splitFilename(".gitignore")).toEqual({ stem: ".gitignore", ext: "" });
    expect(renameSelection("App.tsx")).toEqual([0, 3]);
    expect(validateEntryName("a/b", new Set())).toBe("slash");
    expect(validateEntryName("..", new Set())).toBe("dot");
    expect(validateEntryName("App.tsx", new Set(["App.tsx"]))).toBe("duplicate");
    expect(validateEntryName("App.tsx", new Set(["App.tsx"]), "App.tsx")).toBeUndefined();
    expect(topLevelPaths(["a", "a/b", "c"])).toEqual(["a", "c"]);
    expect(canMoveInto(["src"], "src/nested")).toBe(false);
    expect(canMoveInto(["src/a.ts"], "src")).toBe(false);
    expect(canMoveInto(["src/a.ts"], "lib")).toBe(true);
  });

  it("preserves optimistic writes under unloaded directories across unrelated patches", () => {
    const index = FileTreeIndex.fromSnapshot({
      revision: 1,
      entries: [{ path: "remote", kind: "directory" }],
      loadedDirectoryPaths: new Set([""]),
    });
    index.applyOptimistic(
      "opt-remote",
      { kind: "create", path: "remote/new.ts", entryKind: "file" },
      { inFlight: true },
    );
    expect(index.hasPath("remote/new.ts")).toBe(true);

    // Unrelated patch adding README.md must NOT discard pending remote/new.ts.
    const res = index.applyPatch({
      kind: "create",
      baseRevision: 1,
      nextRevision: 2,
      path: "README.md",
      entryKind: "file",
    });
    expect(res).toEqual({ status: "applied", revision: 2 });
    expect(index.hasPath("README.md")).toBe(true);
    expect(index.hasPath("remote/new.ts")).toBe(true);
    expect(index.getPendingOptimistic()).toHaveLength(1);
  });

  it("projects retryable root lazy error, reloads invalidated collapsed dirs, and prunes dir->file descendants", async () => {
    const rootState = createSubscribable<DirectoryLoadState>({
      status: "error",
      message: "Root offline",
      retryable: true,
    });
    const docsState = createSubscribable<DirectoryLoadState>({
      status: "loaded",
      entries: [{ name: "old.md", kind: "file" }],
    });
    const subState = createSubscribable<DirectoryLoadState>({ status: "idle" });
    const invListeners = new Set<(event: LazyInvalidationEvent) => void>();
    const loadCalls: { readonly dir: string; readonly force?: boolean }[] = [];

    const adapter: FileSystemAdapter = {
      workspaceId: "test-lazy-edge",
      writable: createSubscribable(true),
      lazy: {
        getDirectoryState: (dir) => (dir === "" ? rootState : dir === "sub" ? subState : docsState),
        async loadDirectory(dir, options) {
          loadCalls.push({ dir, force: options?.force });
          if (dir === "") {
            rootState.set({
              status: "loaded",
              entries: [
                { name: "docs", kind: "directory" },
                { name: "sub", kind: "directory" },
              ],
            });
          } else if (dir === "docs") {
            docsState.set({ status: "loaded", entries: [{ name: "fresh.md", kind: "file" }] });
          } else if (dir === "sub") {
            subState.set({ status: "loading" });
          }
        },
        subscribeInvalidation(listener) {
          invListeners.add(listener);
          return () => invListeners.delete(listener);
        },
      },
      listFiles: async () => [],
      readText: async () => "",
      createFile: async () => {},
      createDirectory: async () => {},
      move: async () => {},
      remove: async () => {},
    };

    const model = new FileTreeModel();
    const bound = bindFileSystemAdapter(model, adapter);
    // Root error projects a retryable status row at depth 0 (never blank).
    expect(model.getSnapshot().rows).toEqual([
      expect.objectContaining({ type: "error", directory: "", retryable: true, depth: 0 }),
    ]);

    await bound.ensureDirectoryLoaded("", { force: true });
    expect(model.index.hasPath("docs")).toBe(true);

    // Subscribe & begin loading `sub`, then parent refresh replaces `sub` dir with `sub` file.
    await bound.ensureDirectoryLoaded("sub");
    subState.set({ status: "loaded", entries: [{ name: "child.ts", kind: "file" }] });
    expect(model.index.hasPath("sub/child.ts")).toBe(true);

    rootState.set({
      status: "loaded",
      entries: [
        { name: "docs", kind: "directory" },
        { name: "sub", kind: "file" },
      ],
    });
    expect(model.index.getKind("sub")).toBe("file");
    expect(model.index.hasPath("sub/child.ts")).toBe(false);

    // A late lazy response for retired `sub` or nested `sub/nested` MUST NOT restore directory state.
    subState.set({ status: "loaded", entries: [{ name: "ghost.ts", kind: "file" }] });
    model.index.setLazyDirectoryState("sub", {
      status: "loaded",
      entries: [{ name: "ghost2.ts", kind: "file" }],
    });
    model.index.setLazyDirectoryState("sub/nested", {
      status: "loaded",
      entries: [{ name: "deep.ts", kind: "file" }],
    });
    expect(model.index.getKind("sub")).toBe("file");
    expect(model.index.hasPath("sub/ghost.ts")).toBe(false);
    expect(model.index.hasPath("sub/ghost2.ts")).toBe(false);
    expect(model.index.hasPath("sub/nested/deep.ts")).toBe(false);

    // Remove `sub` completely from loaded root, then deliver a late response for `sub/nested`: no descendants added.
    rootState.set({
      status: "loaded",
      entries: [{ name: "docs", kind: "directory" }],
    });
    expect(model.index.hasPath("sub")).toBe(false);
    model.index.setLazyDirectoryState("sub/nested", {
      status: "loaded",
      entries: [{ name: "deep-removed.ts", kind: "file" }],
    });
    expect(model.index.hasPath("sub")).toBe(false);
    expect(model.index.hasPath("sub/nested")).toBe(false);
    expect(model.index.hasPath("sub/nested/deep-removed.ts")).toBe(false);

    // Optimistic delete of `docs` must NOT retire `docs` lazy subscription on parent refresh.
    await bound.ensureDirectoryLoaded("docs");
    model.index.applyOptimistic("opt-del-docs", { kind: "delete", path: "docs" }, { inFlight: true });
    rootState.set({
      status: "loaded",
      entries: [
        { name: "docs", kind: "directory" },
        { name: "sub", kind: "file" },
      ],
    });
    model.index.rollbackOptimistic("opt-del-docs");
    docsState.set({ status: "loaded", entries: [{ name: "after-rollback.md", kind: "file" }] });
    expect(model.index.hasPath("docs/after-rollback.md")).toBe(true);

    // Invalidate collapsed `docs` while adapter still reports `loaded`; expanding it must force reload.
    for (const listener of invListeners) {
      listener({ directories: ["docs"], reset: false, moves: [], removed: [] });
    }
    await bound.ensureDirectoryLoaded("docs");
    expect(loadCalls).toContainEqual({ dir: "docs", force: true });
    expect(model.index.hasPath("docs/fresh.md")).toBe(true);
    bound.dispose();
  });

  it("transfers focus to the root segment when collapsing an expanded compacted folder chain", () => {
    const model = new FileTreeModel({
      paths: ["a/b/file.ts"],
      initialExpanded: ["a", "a/b"],
    });
    model.select("a/b", "replace", "keyboard");
    const action = navigateTree(model.getSnapshot().rows, "a/b", "ArrowLeft");
    expect(action).toEqual({ collapse: "a", focus: "a" });
    model.setExpanded("a", false);
    expect(model.getSnapshot().focusedPath).toBe("a");
  });

  it("lazily subscribes and loads confirmed directories expanded programmatically without refetching pre-seeded dirs", async () => {
    const rootState = createSubscribable<DirectoryLoadState>({
      status: "loaded",
      entries: [
        { name: "guide", kind: "directory" },
        { name: "seeded", kind: "directory" },
      ],
    });
    const guideState = createSubscribable<DirectoryLoadState>({ status: "idle" });
    const lateState = createSubscribable<DirectoryLoadState>({ status: "idle" });
    const seededState = createSubscribable<DirectoryLoadState>({
      status: "loaded",
      entries: [{ name: "auto.ts", kind: "file" }],
    });
    const loaded: string[] = [];
    const invListeners = new Set<(event: LazyInvalidationEvent) => void>();
    let includeLateInRoot = false;

    const adapter: FileSystemAdapter = {
      workspaceId: "test-lazy-auto-expand",
      writable: createSubscribable(true),
      lazy: {
        getDirectoryState: (dir) =>
          dir === "" ? rootState : dir === "seeded" ? seededState : dir === "late" ? lateState : guideState,
        async loadDirectory(dir) {
          loaded.push(dir);
          if (dir === "") {
            const entries: { readonly name: string; readonly kind: "directory" }[] = [
              { name: "guide", kind: "directory" },
              { name: "seeded", kind: "directory" },
            ];
            if (includeLateInRoot) entries.push({ name: "late", kind: "directory" });
            rootState.set({ status: "loaded", entries });
          } else if (dir === "guide") {
            guideState.set({ status: "loaded", entries: [{ name: "readme.md", kind: "file" }] });
          } else if (dir === "late") {
            lateState.set({ status: "loaded", entries: [{ name: "arrived.ts", kind: "file" }] });
          }
        },
        subscribeInvalidation(listener) {
          invListeners.add(listener);
          return () => invListeners.delete(listener);
        },
      },
      listFiles: async () => [],
      readText: async () => "",
      createFile: async () => {},
      createDirectory: async () => {},
      move: async () => {},
      remove: async () => {},
    };

    const model = new FileTreeModel();
    const bound = bindFileSystemAdapter(model, adapter);

    // Expanding a confirmed directory programmatically (e.g., rebased after rename) loads it.
    model.setExpanded("guide", true);
    await Promise.resolve();
    expect(loaded).toEqual(["guide"]);
    expect(model.index.hasPath("guide/readme.md")).toBe(true);

    // Expanding a pre-seeded loaded directory adopts its entries without calling loadDirectory.
    model.setExpanded("seeded", true);
    await Promise.resolve();
    expect(loaded).toEqual(["guide"]);
    expect(model.index.hasPath("seeded/auto.ts")).toBe(true);

    // Lazy reset with synchronous root publication force-loads each expanded directory only once.
    loaded.length = 0;
    for (const listener of invListeners) {
      listener({ directories: [], reset: true, moves: [], removed: [] });
    }
    await Promise.resolve();
    expect(loaded).toEqual(["", "guide", "seeded"]);

    // Root-only invalidation publishing a previously absent expanded directory subscribes and loads it once.
    model.setExpanded("late", true);
    loaded.length = 0;
    includeLateInRoot = true;
    for (const listener of invListeners) {
      listener({ directories: [""], reset: false, moves: [], removed: [] });
    }
    await Promise.resolve();
    expect(loaded).toEqual(["", "late"]);
    expect(model.index.hasPath("late/arrived.ts")).toBe(true);

    bound.dispose();
  });

  it("reconciles focusedPath, selected, and rename draft when paths are removed by replacePreparedInput or replaceSnapshot", () => {
    const model = new FileTreeModel({ paths: ["remove.ts", "keep.ts"] });
    model.select("remove.ts", "replace", "keyboard");
    model.setDraft({ mode: "rename", path: "remove.ts" });

    model.replacePreparedInput(prepareFileTreeInput(["keep.ts"]));
    expect(model.getSnapshot().focusedPath).toBeUndefined();
    expect(model.getSelectedPaths()).toEqual([]);
    expect(model.getSnapshot().draft).toBeUndefined();

    model.select("keep.ts", "replace", "keyboard");
    model.replaceSnapshot({
      revision: 2,
      entries: [{ path: "other.ts", kind: "file" }],
      loadedDirectoryPaths: new Set([""]),
    });
    expect(model.getSnapshot().focusedPath).toBeUndefined();
    expect(model.getSelectedPaths()).toEqual([]);

    // Indexed move patch rebases selection and focus before reconciling.
    model.replaceSnapshot({
      revision: 3,
      entries: [
        { path: "src", kind: "directory" },
        { path: "src/a.txt", kind: "file" },
        { path: "dst", kind: "directory" },
      ],
      loadedDirectoryPaths: new Set(["", "src", "dst"]),
    });
    model.select("src/a.txt", "replace", "keyboard");
    const moveRes = model.applyPatch({
      kind: "move",
      baseRevision: 3,
      nextRevision: 4,
      moves: [{ from: "/src/a.txt", to: "/dst/a.txt", entryKind: "file" }],
    });
    expect(moveRes).toEqual({ status: "applied", revision: 4 });
    expect(model.getSelectedPaths()).toEqual(["dst/a.txt"]);
    expect(model.getSnapshot().focusedPath).toBe("dst/a.txt");

    // Temporary absence via notifyIndexChange (e.g., optimistic delete rollback or lazy reset) preserves state.
    model.select("other.ts", "replace", "keyboard");
    model.setDraft({ mode: "rename", path: "other.ts" });
    model.index.applyOptimistic("opt-del", { kind: "delete", path: "other.ts" }, { inFlight: true });
    model.notifyIndexChange();
    model.index.rollbackOptimistic("opt-del");
    model.notifyIndexChange();
    expect(model.getSnapshot().focusedPath).toBe("other.ts");
    expect(model.getSelectedPaths()).toEqual(["other.ts"]);
    expect(model.getSnapshot().draft).toEqual({ mode: "rename", path: "other.ts" });
  });

  it("filters files inside unopened lazy directories via adapter.listFiles and refreshes on invalidation", async () => {
    const model = new FileTreeModel();
    const invListeners = new Set<(event: LazyInvalidationEvent) => void>();
    const rootListeners = new Set<() => void>();
    const closedListeners = new Set<() => void>();
    const rootState: DirectoryLoadState = {
      status: "loaded",
      entries: [
        { name: "closed", kind: "directory" },
        { name: "open.ts", kind: "file" },
      ],
    };
    const closedState: DirectoryLoadState = { status: "idle" };
    let workspaceFiles = ["open.ts", "closed/needle.txt"];
    let failListFiles = false;

    const adapter: FileSystemAdapter = {
      workspaceId: "lazy-filter",
      writable: { getSnapshot: () => true, subscribe: () => () => {} },
      listFiles: async () => {
        if (failListFiles) throw new Error("list failed");
        return workspaceFiles.slice();
      },
      readText: async () => undefined,
      size: async () => undefined,
      createFile: async () => {},
      createDirectory: async () => {},
      move: async () => {},
      remove: async () => {},
      lazy: {
        getDirectoryState(dirPath) {
          const isRoot = dirPath === "";
          const listeners = isRoot ? rootListeners : closedListeners;
          return {
            getSnapshot: () => (isRoot ? rootState : closedState),
            subscribe(listener) {
              listeners.add(listener);
              return () => listeners.delete(listener);
            },
          };
        },
        async loadDirectory() {},
        subscribeInvalidation(listener) {
          invListeners.add(listener);
          return () => invListeners.delete(listener);
        },
      },
    };

    const bound = bindFileSystemAdapter(model, adapter);
    // Filter discovers closed/needle.txt even though "closed" was never opened or loaded.
    model.setFilter("needle");
    await Promise.resolve();
    await Promise.resolve();
    const matchedPaths = model
      .getSnapshot()
      .rows.filter((row) => row.type === "entry")
      .map((row) => row.path);
    expect(matchedPaths).toEqual(["closed", "closed/needle.txt"]);
    expect(model.getEntryKind("closed/needle.txt")).toBe("file");

    // Invalidation while filtering keeps existing filtered rows mounted until listFiles resolves, then reflects updates.
    workspaceFiles = ["open.ts", "closed/needle.txt", "closed/needle-two.txt"];
    for (const listener of invListeners) {
      listener({ directories: ["closed"], reset: false, moves: [], removed: [] });
    }
    const whileRefreshingPaths = model
      .getSnapshot()
      .rows.filter((row) => row.type === "entry")
      .map((row) => row.path);
    expect(whileRefreshingPaths).toEqual(["closed", "closed/needle.txt"]);
    await Promise.resolve();
    await Promise.resolve();
    const updatedPaths = model
      .getSnapshot()
      .rows.filter((row) => row.type === "entry")
      .map((row) => row.path);
    expect(updatedPaths).toEqual(["closed", "closed/needle-two.txt", "closed/needle.txt"]);

    // If invalidation refresh fails, previously deleted files in collapsed folders are cleared, not kept searchable.
    failListFiles = true;
    for (const listener of invListeners) {
      listener({ directories: ["closed"], reset: false, moves: [], removed: ["closed/needle.txt"] });
    }
    await Promise.resolve();
    await Promise.resolve();
    const afterFailedRefresh = model
      .getSnapshot()
      .rows.filter((row) => row.type === "entry")
      .map((row) => row.path);
    expect(afterFailedRefresh).toEqual([]);

    // Repopulating works again once listFiles succeeds, and dispose clears auxiliary filter paths.
    failListFiles = false;
    workspaceFiles = ["open.ts", "closed/needle-two.txt"];
    for (const listener of invListeners) {
      listener({ directories: ["closed"], reset: false, moves: [], removed: [] });
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(
      model
        .getSnapshot()
        .rows.filter((row) => row.type === "entry")
        .map((row) => row.path),
    ).toEqual(["closed", "closed/needle-two.txt"]);

    bound.dispose();
    expect(
      model
        .getSnapshot()
        .rows.filter((row) => row.type === "entry")
        .map((row) => row.path),
    ).toEqual([]);

    // Clearing filter leaves "closed" collapsed.
    model.setFilter("");
    const collapsedPaths = model
      .getSnapshot()
      .rows.filter((row) => row.type === "entry")
      .map((row) => row.path);
    expect(collapsedPaths).toEqual(["closed", "open.ts"]);
  });
});
