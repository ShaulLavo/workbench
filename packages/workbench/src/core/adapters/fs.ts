import type { FileTreeSourceAdapter } from "../portable-fs.js";
import type { Subscribable } from "../subscribable.js";

export {
  isOptimisticTreeMutationConfirmed,
  type DirEntry,
  type DirectoryLoadState,
  type EntryKind,
  type FileTreeGitState,
  type FileTreeSourceAdapter,
  type GitStatusCode,
  type IndexedTreePatch,
  type IndexedTreeSnapshot,
  type LazyInvalidationEvent,
  type LazyInvalidationOperation,
  type OptimisticTreeMutation,
} from "../portable-fs.js";

export interface FileUploadItem {
  readonly path: string;
  readonly data?: Blob;
}

export interface FileUploadResult {
  readonly written: readonly string[];
  readonly skipped: number;
}

export interface FileSystemAdapter extends FileTreeSourceAdapter {
  readonly workspaceId: string;
  readonly writable: Subscribable<boolean>;

  readText(path: string): Promise<string | undefined>;
  size?(path: string): Promise<number | undefined>;

  createFile(path: string, content?: string | Uint8Array): Promise<void>;
  createDirectory(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  duplicate?(from: string, to: string): Promise<void>;
  upload?(dirPath: string, items: readonly FileUploadItem[]): Promise<FileUploadResult>;
  prefetch?(path: string): void;
}
