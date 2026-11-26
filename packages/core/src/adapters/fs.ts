import type { Subscribable } from "../subscribable";

export type EntryKind = "file" | "directory";

export interface DirEntry {
  readonly name: string;
  readonly kind: EntryKind;
}

export type DirectoryLoadState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly entries: readonly DirEntry[] }
  | { readonly status: "error"; readonly message: string; readonly retryable: boolean };

export type GitStatusCode =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "ignored"
  | "conflict";

export interface FileTreeGitState {
  readonly statusByPath: ReadonlyMap<string, GitStatusCode>;
  readonly directoriesWithChanges: ReadonlySet<string>;
  readonly ignoredDirectories: ReadonlySet<string>;
}

/** Confirmed indexed snapshot for daemon-backed repos (e.g. Fregat). Preserves empty directories. */
export interface IndexedTreeSnapshot {
  readonly revision: number;
  readonly entries: readonly { readonly path: string; readonly kind: EntryKind }[];
  readonly loadedDirectoryPaths: ReadonlySet<string>;
}

/**
 * Ordered incremental patch against an indexed snapshot.
 * If `patch.baseRevision !== current.revision` or `kind === "reset"`, the tree discards pending
 * patches and requests a resync to the latest confirmed snapshot.
 */
export type IndexedTreePatch =
  | {
      readonly kind: "create";
      readonly baseRevision: number;
      readonly nextRevision: number;
      readonly path: string;
      readonly entryKind: EntryKind;
    }
  | {
      readonly kind: "move";
      readonly baseRevision: number;
      readonly nextRevision: number;
      readonly moves: readonly {
        readonly from: string;
        readonly to: string;
        readonly entryKind: EntryKind;
      }[];
    }
  | {
      readonly kind: "duplicate";
      readonly baseRevision: number;
      readonly nextRevision: number;
      readonly from: string;
      readonly to: string;
      readonly entryKind: EntryKind;
    }
  | {
      readonly kind: "delete";
      readonly baseRevision: number;
      readonly nextRevision: number;
      readonly path: string;
    }
  | {
      readonly kind: "reset";
      readonly nextRevision: number;
    };

export type OptimisticTreeMutation =
  | { readonly kind: "create"; readonly path: string; readonly entryKind: EntryKind }
  | {
      readonly kind: "move";
      readonly moves: readonly {
        readonly from: string;
        readonly to: string;
        readonly entryKind: EntryKind;
      }[];
    }
  | { readonly kind: "duplicate"; readonly from: string; readonly to: string; readonly entryKind: EntryKind }
  | { readonly kind: "delete"; readonly path: string };

export interface LazyInvalidationEvent {
  readonly directories: readonly string[];
  readonly reset: boolean;
  readonly moves: readonly { readonly from: string; readonly to: string; readonly operation: number }[];
  readonly removed: readonly string[];
}

export interface FileUploadItem {
  readonly path: string;
  readonly data?: Blob;
}

export interface FileUploadResult {
  readonly written: readonly string[];
  readonly skipped: number;
}

export interface FileSystemAdapter {
  readonly workspaceId: string;
  readonly writable: Subscribable<boolean>;

  listFiles(): Promise<readonly string[]>;
  readText(path: string): Promise<string | undefined>;
  size?(path: string): Promise<number | undefined>;

  createFile(path: string, content?: string | Uint8Array): Promise<void>;
  createDirectory(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  duplicate?(from: string, to: string): Promise<void>;
  upload?(dirPath: string, items: readonly FileUploadItem[]): Promise<FileUploadResult>;

  /** Mode A (lazy, e.g. Sprockt Waffle): per-directory state, load/retry, and invalidation. */
  readonly lazy?: {
    getDirectoryState(dirPath: string): Subscribable<DirectoryLoadState>;
    loadDirectory(dirPath: string, options?: { readonly force?: boolean }): Promise<void>;
    subscribeInvalidation(listener: (event: LazyInvalidationEvent) => void): () => void;
  };

  /** Mode B (indexed, e.g. Fregat daemon): confirmed snapshot + ordered patch stream. */
  readonly indexed?: {
    readonly snapshot: Subscribable<IndexedTreeSnapshot | undefined>;
    subscribePatches(listener: (patch: IndexedTreePatch) => void): () => void;
    requestResync(): Promise<void>;
  };

  readonly git?: Subscribable<FileTreeGitState>;
  prefetch?(path: string): void;
}

function parentDirectoryOf(treePath: string): string {
  const normalized = treePath.endsWith("/") ? treePath.slice(0, -1) : treePath;
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? "" : normalized.slice(0, slash);
}

function hasSnapshotPath(snapshot: IndexedTreeSnapshot, targetPath: string): boolean {
  const canonical = targetPath.endsWith("/") ? targetPath.slice(0, -1) : targetPath;
  return snapshot.entries.some((entry) => {
    const entryPath = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
    return entryPath === canonical;
  });
}

function destinationSettled(snapshot: IndexedTreeSnapshot, targetPath: string): boolean {
  if (hasSnapshotPath(snapshot, targetPath)) return true;
  const parent = parentDirectoryOf(targetPath);
  // Root directory is always loaded, so a pending root-level create/move never settles before appearing.
  if (parent === "") return false;
  return !snapshot.loadedDirectoryPaths.has(parent);
}

/**
 * Checks whether an optimistic mutation is settled against a confirmed indexed snapshot.
 * Destinations inside unloaded directories count as settled so intents do not stall.
 */
export function isOptimisticTreeMutationConfirmed(
  snapshot: IndexedTreeSnapshot,
  mutation: OptimisticTreeMutation,
): boolean {
  switch (mutation.kind) {
    case "create":
      return destinationSettled(snapshot, mutation.path);
    case "move":
      return mutation.moves.every(
        (move) => !hasSnapshotPath(snapshot, move.from) && destinationSettled(snapshot, move.to),
      );
    case "duplicate":
      return destinationSettled(snapshot, mutation.to);
    case "delete":
      return !hasSnapshotPath(snapshot, mutation.path);
  }
}
