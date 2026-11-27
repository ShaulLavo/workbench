import type { ActivationFocusDecision } from "../focus-policy.js";
import type { Subscribable } from "../subscribable.js";

export type DocumentId = string;
export type TabId = string;
export type GroupId = string;
export type SplitId = string;

export type WriteOutcome =
  | { readonly written: true; readonly nextRevision: string }
  | {
      readonly written: false;
      readonly currentText: string | undefined;
      readonly currentRevision: string | undefined;
    };

export interface DocumentConflict {
  readonly documentId: DocumentId;
  readonly path?: string;
  readonly diskText: string | undefined;
}

export interface MoveLockHandle {
  release(moved: boolean): void;
}

export interface LoadedDocument {
  readonly text: string;
  readonly revision: string;
  readonly languageId?: string;
  readonly byteLength: number;
  readonly readOnly?: boolean;
}

export interface EditorTabDescriptor {
  readonly id: TabId;
  readonly documentId: DocumentId;
  readonly kind: "file" | "diff" | "virtual";
  readonly path?: string;
  readonly label: string;
  readonly hint?: string;
  readonly title: string;
  readonly tone?: string;
  readonly preview?: boolean;
  readonly dirty?: boolean;
  readonly missing?: boolean;
  readonly readOnly?: boolean;
  readonly loading?: boolean;
}

export interface EditorGroupNode {
  readonly kind: "group";
  readonly id: GroupId;
  readonly tabs: readonly EditorTabDescriptor[];
  readonly selectedTabId: TabId | null;
}

export interface EditorSplitChild {
  readonly node: EditorGroupTreeNode;
  readonly size: number;
}

export interface EditorSplitNode {
  readonly kind: "split";
  readonly id: SplitId;
  readonly axis: "horizontal" | "vertical";
  readonly children: readonly [EditorSplitChild, EditorSplitChild, ...EditorSplitChild[]];
}

export type EditorGroupTreeNode = EditorGroupNode | EditorSplitNode;

export interface EditorGroupsSnapshot {
  readonly root: EditorGroupTreeNode;
  readonly activeGroupId: GroupId;
}

export type TabPlacementTarget =
  | { readonly kind: "group"; readonly groupId: GroupId }
  | { readonly kind: "strip"; readonly groupId: GroupId; readonly beforeTabId: TabId | null }
  | { readonly kind: "edge"; readonly groupId: GroupId; readonly edge: "left" | "right" | "top" | "bottom" };

export interface TabPlacement {
  readonly tabId: TabId;
  readonly mode: "move" | "copy";
  readonly target: TabPlacementTarget;
}

export interface EditorDocumentAdapter {
  getConflict(documentId: DocumentId): Subscribable<DocumentConflict | undefined>;
  loadDocument(documentId: DocumentId): Promise<LoadedDocument | undefined>;
  writeIfUnchanged(
    documentId: DocumentId,
    text: string,
    expectedRevision: string | undefined,
  ): Promise<WriteOutcome>;
  save(documentId: DocumentId): Promise<void>;
  saveAll?(): Promise<void>;
  resolveConflict?(documentId: DocumentId, choice: "keep-mine" | "take-theirs"): Promise<void>;
  lockPaths?(roots: readonly string[]): Promise<MoveLockHandle>;
  /** Size threshold in bytes (default 2 MiB) above which syntax highlighting and LSP disable cleanly. */
  readonly maxAnalysisBytes?: number;
}

export interface OpenDocumentOptions {
  readonly groupId?: GroupId;
  readonly preview?: boolean;
  readonly line?: number;
  readonly column?: number;
  readonly focus: ActivationFocusDecision;
}

export interface EditorGroupAdapter {
  readonly groups: Subscribable<EditorGroupsSnapshot>;

  /** Selects an existing tab (file, diff, or virtual) in its group by TabId. */
  selectTab(groupId: GroupId, tabId: TabId, focus: ActivationFocusDecision): void;
  /** Opens a document (or selects its existing tab in target group, defaulting to activeGroupId). */
  openDocument(documentId: DocumentId, options: OpenDocumentOptions): void;
  closeTabs(groupId: GroupId, tabIds: readonly TabId[]): void;
  pinTab(groupId: GroupId, tabId: TabId): void;
  placeTab(placement: TabPlacement): void;
  resizeSplit?(
    splitId: SplitId,
    sizes: readonly { readonly id: GroupId | SplitId; readonly size: number }[],
  ): void;
  setActiveGroup?(groupId: GroupId): void;
}
