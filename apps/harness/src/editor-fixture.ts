import type {
  DocumentConflict,
  DocumentId,
  EditorDocumentAdapter,
  EditorGroupAdapter,
  EditorGroupsSnapshot,
  EditorGroupTreeNode,
  EditorTabDescriptor,
  GroupId,
  LoadedDocument,
  LspHostAdapter,
  LspServerStatus,
  Subscribable,
  TabId,
} from "@shaulavo/workbench/core";
import type { ComposerMentionItem, ComposerSlashCommand } from "@shaulavo/workbench/editor/composer";
import { applyTabPlacement } from "@shaulavo/workbench/editor/groups";

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

interface StoredDoc {
  text: string;
  revision: number;
  languageId?: string;
}

export interface HarnessEditorBundle {
  readonly documents: EditorDocumentAdapter;
  readonly groups: EditorGroupAdapter;
  readonly lsp: LspHostAdapter;
  readonly mentionItems: readonly ComposerMentionItem[];
  readonly slashCommands: readonly ComposerSlashCommand[];
  readonly savedCount: Subscribable<number>;
  splitActiveRight(): void;
  openLargeFile(): void;
  triggerConflict(documentId: DocumentId): void;
}

function harnessDiffLine(index: number, line4: string, line43: string): string {
  if (index === 3) return line4;
  if (index === 42) return line43;
  return `  const line${index + 1} = ${index + 1};`;
}

export const HARNESS_DIFF_ORIGINAL = Array.from({ length: 70 }, (_, i) =>
  harnessDiffLine(i, '  const greeting = "Old Workbench";', '  return "Legacy line 42";'),
).join("\n");

export const HARNESS_DIFF_MODIFIED = Array.from({ length: 70 }, (_, i) =>
  harnessDiffLine(i, '  const greeting = "Shared Workbench Ready";', '  return "Updated line 42";'),
).join("\n");

const INITIAL_DOCS: Readonly<Record<string, { readonly text: string; readonly languageId: string }>> = {
  "src/App.tsx": {
    languageId: "tsx",
    text: [
      'import { WorkbenchShell } from "@shaulavo/workbench";',
      "",
      "export function App() {",
      '  const greeting = "Shared Workbench Ready";',
      "  return <WorkbenchShell>{greeting}</WorkbenchShell>;",
      "}",
      "",
    ].join("\n"),
  },
  "src/styles.css": {
    languageId: "css",
    text: [
      "@layer workbench-app {",
      "  .hero {",
      "    color: var(--wb-fg);",
      "    background: var(--wb-bg-well);",
      "  }",
      "}",
      "",
    ].join("\n"),
  },
  "package.json": {
    languageId: "json",
    text: JSON.stringify({ name: "demo-app", version: "0.1.0", private: true }, null, 2) + "\n",
  },
  "CLAUDE.md": {
    languageId: "markdown",
    text: "# Project notes\n\nUse `@shaulavo/workbench-editor` for shared editing.\n",
  },
};

function updateGroupTree(
  node: EditorGroupTreeNode,
  groupId: GroupId,
  fn: (
    tabs: readonly EditorTabDescriptor[],
    selectedTabId: TabId | null,
  ) => {
    readonly tabs: readonly EditorTabDescriptor[];
    readonly selectedTabId: TabId | null;
  },
): EditorGroupTreeNode {
  if (node.kind === "group") {
    if (node.id !== groupId) return node;
    const next = fn(node.tabs, node.selectedTabId);
    return { ...node, tabs: next.tabs, selectedTabId: next.selectedTabId };
  }
  const children = node.children.map((child) => ({
    ...child,
    node: updateGroupTree(child.node, groupId, fn),
  }));
  const [first, second, ...rest] = children;
  return { ...node, children: [first!, second!, ...rest] };
}

function findFirstGroup(node: EditorGroupTreeNode): GroupId {
  return node.kind === "group" ? node.id : findFirstGroup(node.children[0].node);
}

/** In-memory Phase 4 editor fixture supporting Singapore, split groups, large files, conflicts, and LSP status. */
export function createHarnessEditorBundle(): HarnessEditorBundle {
  const docs = new Map<string, StoredDoc>();
  for (const [id, spec] of Object.entries(INITIAL_DOCS)) {
    docs.set(id, { text: spec.text, revision: 1, languageId: spec.languageId });
  }
  // 2.1 MiB synthetic file to exercise large-file tiering (> DEFAULT_MAX_ANALYSIS_BYTES).
  const largeText = `${"const line = 'large-file-payload-0123456789';\n".repeat(48_000)}`;
  docs.set("logs/large.log", { text: largeText, revision: 1, languageId: "typescript" });

  const conflicts = new Map<string, ReturnType<typeof createSubscribable<DocumentConflict | undefined>>>();
  const savedCount = createSubscribable(0);

  function conflictCell(documentId: DocumentId) {
    let cell = conflicts.get(documentId);
    if (!cell) {
      cell = createSubscribable<DocumentConflict | undefined>(undefined);
      conflicts.set(documentId, cell);
    }
    return cell;
  }

  const initialTabs: readonly EditorTabDescriptor[] = [
    {
      id: "src/App.tsx",
      documentId: "src/App.tsx",
      kind: "file",
      path: "src/App.tsx",
      label: "App.tsx",
      title: "src/App.tsx",
    },
    {
      id: "src/styles.css",
      documentId: "src/styles.css",
      kind: "file",
      path: "src/styles.css",
      label: "styles.css",
      title: "src/styles.css",
      preview: true,
    },
    {
      id: "package.json",
      documentId: "package.json",
      kind: "file",
      path: "package.json",
      label: "package.json",
      title: "package.json",
    },
    {
      id: "CLAUDE.md",
      documentId: "CLAUDE.md",
      kind: "file",
      path: "CLAUDE.md",
      label: "CLAUDE.md",
      title: "CLAUDE.md",
    },
  ];

  const groupsSub = createSubscribable<EditorGroupsSnapshot>({
    activeGroupId: "main",
    root: {
      kind: "group",
      id: "main",
      tabs: initialTabs,
      selectedTabId: "src/App.tsx",
    },
  });

  const documents: EditorDocumentAdapter = {
    getConflict: (documentId) => conflictCell(documentId),
    async loadDocument(documentId): Promise<LoadedDocument | undefined> {
      const entry = docs.get(documentId);
      if (!entry) return undefined;
      return {
        text: entry.text,
        revision: String(entry.revision),
        languageId: entry.languageId,
        byteLength: new TextEncoder().encode(entry.text).byteLength,
      };
    },
    async writeIfUnchanged(documentId, text, expectedRevision) {
      const entry = docs.get(documentId);
      if (!entry) {
        return { written: false, currentText: undefined, currentRevision: undefined };
      }
      if (expectedRevision !== undefined && expectedRevision !== String(entry.revision)) {
        return { written: false, currentText: entry.text, currentRevision: String(entry.revision) };
      }
      entry.text = text;
      entry.revision += 1;
      return { written: true, nextRevision: String(entry.revision) };
    },
    async save() {
      savedCount.set(savedCount.getSnapshot() + 1);
    },
    async resolveConflict(documentId, choice) {
      const cell = conflictCell(documentId);
      const activeConflict = cell.getSnapshot();
      const entry = docs.get(documentId);
      if (choice === "take-theirs" && entry && activeConflict?.diskText !== undefined) {
        entry.text = activeConflict.diskText;
        entry.revision += 1;
      }
      cell.set(undefined);
    },
  };

  const groups: EditorGroupAdapter = {
    groups: groupsSub,
    selectTab(groupId, tabId) {
      const cur = groupsSub.getSnapshot();
      groupsSub.set({
        activeGroupId: groupId,
        root: updateGroupTree(cur.root, groupId, (tabs) => ({ tabs, selectedTabId: tabId })),
      });
    },
    openDocument(documentId, options) {
      const cur = groupsSub.getSnapshot();
      const groupId = options.groupId ?? cur.activeGroupId;
      const label = documentId.slice(documentId.lastIndexOf("/") + 1);
      groupsSub.set({
        activeGroupId: groupId,
        root: updateGroupTree(cur.root, groupId, (tabs) => {
          const existing = tabs.find((t) => t.documentId === documentId);
          if (existing) return { tabs, selectedTabId: existing.id };
          const tab: EditorTabDescriptor = {
            id: documentId,
            documentId,
            kind: "file",
            path: documentId,
            label,
            title: documentId,
            preview: options.preview,
          };
          return { tabs: tabs.concat([tab]), selectedTabId: tab.id };
        }),
      });
    },
    closeTabs(groupId, tabIds) {
      const drop = new Set(tabIds);
      const cur = groupsSub.getSnapshot();
      const nextRoot = updateGroupTree(cur.root, groupId, (tabs, selectedTabId) => {
        const remaining = tabs.filter((t) => !drop.has(t.id));
        const nextSel = selectedTabId && drop.has(selectedTabId) ? (remaining[0]?.id ?? null) : selectedTabId;
        return { tabs: remaining, selectedTabId: nextSel };
      });
      groupsSub.set({ activeGroupId: findFirstGroup(nextRoot), root: nextRoot });
    },
    pinTab(groupId, tabId) {
      const cur = groupsSub.getSnapshot();
      groupsSub.set({
        ...cur,
        root: updateGroupTree(cur.root, groupId, (tabs, selectedTabId) => ({
          tabs: tabs.map((t) => (t.id === tabId ? { ...t, preview: false } : t)),
          selectedTabId,
        })),
      });
    },
    placeTab(placement) {
      groupsSub.set(applyTabPlacement(groupsSub.getSnapshot(), placement));
    },
    setActiveGroup(groupId) {
      const cur = groupsSub.getSnapshot();
      if (cur.activeGroupId !== groupId) groupsSub.set({ ...cur, activeGroupId: groupId });
    },
  };

  const lspStatus = createSubscribable<LspServerStatus>({
    state: "ready",
    label: "TypeScript",
    errorCount: 1,
    warningCount: 0,
  });

  const lsp: LspHostAdapter = {
    status: lspStatus,
    pathToUri: (p) => `file:///workspace/${p}`,
    uriToPath: (u) => (u.startsWith("file:///workspace/") ? u.slice("file:///workspace/".length) : null),
    openLocation(loc, focus) {
      groups.openDocument(loc.path, { line: loc.line, column: loc.column, focus });
      return true;
    },
  };

  const mentionItems: readonly ComposerMentionItem[] = [
    { id: "app", path: "src/App.tsx", label: "App.tsx", detail: "src/App.tsx" },
    { id: "styles", path: "src/styles.css", label: "styles.css", detail: "src/styles.css" },
    { id: "pkg", path: "package.json", label: "package.json", detail: "package.json" },
    { id: "claude", path: "CLAUDE.md", label: "CLAUDE.md", detail: "CLAUDE.md" },
    { id: "comma", path: "src/a,b.ts", label: "a,b.ts", detail: "src/a,b.ts" },
    {
      id: "bracket",
      path: "docs/closing ] bracket.md",
      label: "closing ] bracket.md",
      detail: "docs/closing ] bracket.md",
    },
  ];

  const slashCommands: readonly ComposerSlashCommand[] = [
    { id: "fix", name: "fix", description: "Fix TypeScript diagnostics", insertText: "Fix diagnostics in " },
    { id: "explain", name: "explain", description: "Explain active selection", insertText: "Explain " },
    { id: "test", name: "test", description: "Write unit tests", insertText: "Add tests for " },
  ];

  return {
    documents,
    groups,
    lsp,
    mentionItems,
    slashCommands,
    savedCount,
    splitActiveRight() {
      const cur = groupsSub.getSnapshot();
      const targetTab =
        cur.root.kind === "group" ? (cur.root.tabs[1]?.id ?? cur.root.tabs[0]?.id) : "src/styles.css";
      if (!targetTab) return;
      groups.placeTab({
        tabId: targetTab,
        mode: "copy",
        target: { kind: "edge", groupId: cur.activeGroupId, edge: "right" },
      });
    },
    openLargeFile() {
      groups.openDocument("logs/large.log", {
        focus: { shouldFocusEditor: false, origin: "programmatic" },
      });
    },
    triggerConflict(documentId) {
      conflictCell(documentId).set({
        documentId,
        path: documentId,
        diskText: "// Updated externally on disk\nexport const fromDisk = true;\n",
      });
    },
  };
}
