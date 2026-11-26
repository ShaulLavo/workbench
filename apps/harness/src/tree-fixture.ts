import type {
  DirectoryLoadState,
  EntryKind,
  FileSystemAdapter,
  FileTreeGitState,
  IndexedTreePatch,
  IndexedTreeSnapshot,
  Subscribable,
} from "@shaulavo/workbench-core";
import { FileTreeModel, prepareFileTreeInput, type PreparedFileTreeInput } from "@shaulavo/workbench-tree";

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

export interface HarnessTreeBundle {
  readonly model: FileTreeModel;
  readonly adapter: FileSystemAdapter;
  readonly entryCountLabel: string;
}

const DEMO_PATHS: readonly string[] = [
  "src/features/editor/App.tsx",
  "src/features/editor/toolbar.tsx",
  "src/components/Button.tsx",
  "src/components/Panel.tsx",
  "src/components/Dialog.tsx",
  "src/styles.css",
  "src/App.test.tsx",
  "src/utils/format.ts",
  "src/utils/paths.ts",
  "docs/getting-started.md",
  "docs/architecture.md",
  "docs/shortcuts.md",
  "packages/core/index.ts",
  "packages/core/theme.ts",
  "packages/ui/shell.tsx",
  "packages/ui/dialog.tsx",
  "packages/tokens/tokens.css",
  "node_modules/example-pkg/index.js",
  "CLAUDE.md",
  "README.md",
  "LICENSE",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  ".gitignore",
];

const DEMO_GIT: FileTreeGitState = {
  statusByPath: new Map([
    ["src/features/editor/App.tsx", "modified"],
    ["CLAUDE.md", "added"],
    ["docs/getting-started.md", "untracked"],
  ]),
  directoriesWithChanges: new Set(["src", "src/features", "src/features/editor", "docs"]),
  ignoredDirectories: new Set(["node_modules"]),
};

/** Interactive 25-file indexed workspace fixture with compact chains, git badges, and mutations. */
export function createDemoIndexedTree(): HarnessTreeBundle {
  let revision = 1;
  const entriesMap = new Map<string, EntryKind>();
  for (const path of DEMO_PATHS) {
    entriesMap.set(path, "file");
  }

  const buildSnapshot = (): IndexedTreeSnapshot => {
    const loadedDirectoryPaths = new Set<string>([""]);
    for (const p of entriesMap.keys()) {
      let slash = p.indexOf("/");
      while (slash !== -1) {
        loadedDirectoryPaths.add(p.slice(0, slash));
        slash = p.indexOf("/", slash + 1);
      }
    }
    return {
      revision,
      entries: Array.from(entriesMap, ([path, kind]) => ({ path, kind })),
      loadedDirectoryPaths,
    };
  };

  const snapshot = createSubscribable<IndexedTreeSnapshot | undefined>(buildSnapshot());
  const git = createSubscribable<FileTreeGitState>(DEMO_GIT);
  const writable = createSubscribable(true);
  const patchListeners = new Set<(patch: IndexedTreePatch) => void>();

  function emitPatch(patch: IndexedTreePatch): void {
    for (const listener of patchListeners) listener(patch);
  }

  const adapter: FileSystemAdapter = {
    workspaceId: "harness-demo",
    writable,
    git,
    indexed: {
      snapshot,
      subscribePatches(listener) {
        patchListeners.add(listener);
        return () => {
          patchListeners.delete(listener);
        };
      },
      async requestResync() {
        snapshot.set(buildSnapshot());
      },
    },
    async listFiles() {
      return Array.from(entriesMap.keys());
    },
    async readText(path) {
      return `// ${path}\nexport const ok = true;\n`;
    },
    async createFile(path) {
      const baseRevision = revision;
      revision += 1;
      entriesMap.set(path, "file");
      emitPatch({ kind: "create", baseRevision, nextRevision: revision, path, entryKind: "file" });
    },
    async createDirectory(path) {
      const baseRevision = revision;
      revision += 1;
      entriesMap.set(path, "directory");
      emitPatch({
        kind: "create",
        baseRevision,
        nextRevision: revision,
        path,
        entryKind: "directory",
      });
    },
    async move(from, to) {
      const baseRevision = revision;
      revision += 1;
      const entryKind = entriesMap.get(from) ?? "file";
      entriesMap.delete(from);
      entriesMap.set(to, entryKind);
      emitPatch({
        kind: "move",
        baseRevision,
        nextRevision: revision,
        moves: [{ from, to, entryKind }],
      });
    },
    async remove(path) {
      const baseRevision = revision;
      revision += 1;
      entriesMap.delete(path);
      for (const existing of Array.from(entriesMap.keys())) {
        if (existing.startsWith(`${path}/`)) entriesMap.delete(existing);
      }
      emitPatch({ kind: "delete", baseRevision, nextRevision: revision, path });
    },
  };

  const model = new FileTreeModel({
    initialExpanded: ["src", "src/features", "src/features/editor", "docs"],
  });

  return { model, adapter, entryCountLabel: "25 files" };
}

let cached50kPrepared: PreparedFileTreeInput | null = null;

function get50kPrepared(): PreparedFileTreeInput {
  if (cached50kPrepared) return cached50kPrepared;
  const paths: string[] = [];
  for (let i = 0; i < 50_000; i += 1) {
    const group = `pkg-${String(i % 250).padStart(3, "0")}`;
    const feature = `feature-${String(Math.floor(i / 250) % 40).padStart(2, "0")}`;
    const leaf =
      i % 11 === 0 ? `nested-${String(i).padStart(5, "0")}/` : `file-${String(i).padStart(5, "0")}.ts`;
    paths.push(`packages/${group}/src/${feature}/${leaf}`);
  }
  cached50kPrepared = prepareFileTreeInput(paths, { revision: 1 });
  return cached50kPrepared;
}

/** 50,000-path prepared tree fixture verifying smooth windowing and sticky ancestor headers. */
export function create50kScaleTree(): HarnessTreeBundle {
  const prepared = get50kPrepared();
  const model = new FileTreeModel({
    preparedInput: prepared,
    initialExpanded: [
      "packages",
      "packages/pkg-000",
      "packages/pkg-000/src",
      "packages/pkg-000/src/feature-00",
      "packages/pkg-001",
      "packages/pkg-001/src",
    ],
  });
  const adapter: FileSystemAdapter = {
    workspaceId: "harness-50k",
    writable: createSubscribable(false),
    listFiles: async () => [],
    readText: async (path) => `// ${path}\n`,
    createFile: async () => {},
    createDirectory: async () => {},
    move: async () => {},
    remove: async () => {},
  };
  return { model, adapter, entryCountLabel: "50,000 files" };
}

/** Lazy per-directory fixture whose `remote-logs` folder fails once, then succeeds on Retry. */
export function createLazyDemoTree(): HarnessTreeBundle {
  const states = new Map<
    string,
    Subscribable<DirectoryLoadState> & { set(next: DirectoryLoadState): void }
  >();
  const getState = (dir: string) => {
    let sub = states.get(dir);
    if (!sub) {
      sub = createSubscribable<DirectoryLoadState>(
        dir === ""
          ? {
              status: "loaded",
              entries: [
                { name: "remote-logs", kind: "directory" },
                { name: "CLAUDE.md", kind: "file" },
                { name: "README.md", kind: "file" },
              ],
            }
          : { status: "idle" },
      );
      states.set(dir, sub);
    }
    return sub;
  };

  let remoteAttempts = 0;

  const adapter: FileSystemAdapter = {
    workspaceId: "harness-lazy",
    writable: createSubscribable(true),
    lazy: {
      getDirectoryState: (dir) => getState(dir),
      async loadDirectory(dir) {
        if (dir !== "remote-logs") return;
        remoteAttempts += 1;
        const sub = getState(dir);
        if (remoteAttempts === 1) {
          sub.set({ status: "error", message: "Connection timed out", retryable: true });
          return;
        }
        sub.set({
          status: "loaded",
          entries: [
            { name: "metrics.json", kind: "file" },
            { name: "server.log", kind: "file" },
          ],
        });
      },
      subscribeInvalidation: () => () => {},
    },
    listFiles: async () => [],
    readText: async (path) => `// ${path}\n`,
    createFile: async () => {},
    createDirectory: async () => {},
    move: async () => {},
    remove: async () => {},
  };

  const model = new FileTreeModel({ initialExpanded: ["remote-logs"] });
  return { model, adapter, entryCountLabel: "Lazy mode" };
}
