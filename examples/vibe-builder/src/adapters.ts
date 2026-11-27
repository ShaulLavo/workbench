import {
  DEFAULT_PANE_GEOMETRY,
  type DocumentConflict,
  type EditorDocumentAdapter,
  type EditorGroupAdapter,
  type EditorGroupsSnapshot,
  type EditorTabDescriptor,
  type FileSystemAdapter,
  type GlobalPaneGeometry,
  type IndexedTreeSnapshot,
  type LayoutAdapter,
  type PreviewAdapter,
  type Subscribable,
  type TerminalAdapter,
  type TerminalSessionInfo,
  type TerminalStreamEvent,
  type WorkbenchPaneId,
} from "@shaulavo/workbench/core";
import type { ComposerMentionItem, ComposerSlashCommand } from "@shaulavo/workbench/editor/composer";
import { createBridgelessPreviewController } from "@shaulavo/workbench/preview";

function cell<T>(initial: T): Subscribable<T> & { set(next: T): void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    set(next: T) {
      value = next;
      for (const fn of listeners) fn();
    },
  };
}

export interface AgentMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly mentions: readonly string[];
}

export interface VibeBuilderBackend {
  readonly fs: FileSystemAdapter;
  readonly documents: EditorDocumentAdapter;
  readonly groups: EditorGroupAdapter;
  readonly terminal: TerminalAdapter;
  readonly preview: PreviewAdapter;
  readonly layout: LayoutAdapter;
  readonly messages: Subscribable<readonly AgentMessage[]>;
  readonly mentionItems: readonly ComposerMentionItem[];
  readonly slashCommands: readonly ComposerSlashCommand[];
  submitPrompt(text: string, mentions: readonly string[]): void;
}

const STARTER_FILES: Readonly<Record<string, string>> = {
  "src/App.tsx": "export function App() {\n  return <main><h1>Vibe Starter</h1></main>;\n}\n",
  "src/routes/pricing.tsx":
    "export function Pricing() {\n  return <section>Pro plan — $19/mo</section>;\n}\n",
  "src/styles.css": "body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; }\n",
  "package.json": '{\n  "name": "vibe-starter-app",\n  "version": "0.1.0",\n  "private": true\n}\n',
};

const tabFor = (path: string): EditorTabDescriptor => ({
  id: path,
  documentId: path,
  kind: "file",
  path,
  label: path.slice(path.lastIndexOf("/") + 1),
  title: path,
});

/** Complete in-memory Consumer 3 workbench adapter set (< 295 lines of glue). */
export function createVibeBuilderBackend(): VibeBuilderBackend {
  const files = new Map(Object.entries(STARTER_FILES).map(([p, text]) => [p, { text, rev: 1 }]));
  const dirs = new Set<string>(["src", "src/routes"]);
  let treeRev = 1;
  const addParents = (p: string): void => {
    for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) dirs.add(p.slice(0, i));
  };
  const buildSnap = (): IndexedTreeSnapshot => {
    const entries: { readonly path: string; readonly kind: "file" | "directory" }[] = [];
    for (const d of dirs) entries.push({ path: d, kind: "directory" });
    for (const p of files.keys()) entries.push({ path: p, kind: "file" });
    return { revision: treeRev, entries, loadedDirectoryPaths: new Set(["", ...dirs]) };
  };
  const treeSnap = cell(buildSnap());
  const pushTree = (): void => {
    treeRev += 1;
    treeSnap.set(buildSnap());
  };
  const rebasePrefix = (p: string, from: string, to: string): string =>
    p === from ? to : `${to}${p.slice(from.length)}`;

  const fs: FileSystemAdapter = {
    workspaceId: "vibe-builder",
    writable: cell(true),
    listFiles: async () => Array.from(files.keys()),
    readText: async (p) => files.get(p)?.text,
    createFile: async (p, content = "") => {
      const text = typeof content === "string" ? content : new TextDecoder().decode(content);
      addParents(p);
      files.set(p, { text, rev: 1 });
      pushTree();
    },
    createDirectory: async (p) => {
      addParents(p);
      dirs.add(p);
      pushTree();
    },
    move: async (from, to) => {
      const prefix = `${from}/`;
      const movedFiles = Array.from(files.entries()).filter(([p]) => p === from || p.startsWith(prefix));
      const movedDirs = Array.from(dirs).filter((d) => d === from || d.startsWith(prefix));
      if (movedFiles.length === 0 && movedDirs.length === 0) return;
      addParents(to);
      for (const [p] of movedFiles) files.delete(p);
      for (const [p, entry] of movedFiles) files.set(rebasePrefix(p, from, to), entry);
      for (const d of movedDirs) dirs.delete(d);
      for (const d of movedDirs) dirs.add(rebasePrefix(d, from, to));
      pushTree();
    },
    remove: async (p) => {
      const prefix = `${p}/`;
      for (const k of Array.from(files.keys())) if (k === p || k.startsWith(prefix)) files.delete(k);
      for (const d of Array.from(dirs)) if (d === p || d.startsWith(prefix)) dirs.delete(d);
      pushTree();
    },
    indexed: {
      snapshot: treeSnap,
      subscribePatches: () => () => undefined,
      requestResync: async () => treeSnap.set(buildSnap()),
    },
  };

  const noConflict = cell<DocumentConflict | undefined>(undefined);
  const documents: EditorDocumentAdapter = {
    getConflict: () => noConflict,
    loadDocument: async (id) => {
      const e = files.get(id);
      return e ? { text: e.text, revision: String(e.rev), byteLength: e.text.length } : undefined;
    },
    writeIfUnchanged: async (id, text, expected) => {
      const e = files.get(id);
      if (!e) return { written: false, currentText: undefined, currentRevision: undefined };
      if (expected !== undefined && expected !== String(e.rev)) {
        return { written: false, currentText: e.text, currentRevision: String(e.rev) };
      }
      e.text = text;
      e.rev += 1;
      return { written: true, nextRevision: String(e.rev) };
    },
    save: async () => undefined,
  };

  const groupsState = cell<EditorGroupsSnapshot>({
    activeGroupId: "main",
    root: {
      kind: "group",
      id: "main",
      tabs: [tabFor("src/App.tsx"), tabFor("src/styles.css")],
      selectedTabId: "src/App.tsx",
    },
  });
  const setMain = (tabs: readonly EditorTabDescriptor[], selectedTabId: string | null): void =>
    groupsState.set({ activeGroupId: "main", root: { kind: "group", id: "main", tabs, selectedTabId } });
  const getTabs = (): readonly EditorTabDescriptor[] => {
    const r = groupsState.getSnapshot().root;
    return r.kind === "group" ? r.tabs : [];
  };
  const groups: EditorGroupAdapter = {
    groups: groupsState,
    selectTab: (_g, tabId) => setMain(getTabs(), tabId),
    openDocument: (id) => {
      const tabs = getTabs();
      setMain(tabs.some((t) => t.id === id) ? tabs : tabs.concat([tabFor(id)]), id);
    },
    closeTabs: (_g, ids) => {
      const drop = new Set(ids);
      const next = getTabs().filter((t) => !drop.has(t.id));
      setMain(next, next[0]?.id ?? null);
    },
    pinTab: () => undefined,
    placeTab: () => undefined,
  };

  const termListeners = new Set<(event: TerminalStreamEvent) => void>();
  const sessions = cell<readonly TerminalSessionInfo[]>([
    { id: "sandbox-1", title: "sandbox", status: "running" },
  ]);
  const activeId = cell<string | undefined>("sandbox-1");
  const terminal: TerminalAdapter = {
    sessions,
    activeId,
    splitId: cell<string | undefined>(undefined),
    createSession: async () => "sandbox-1",
    closeSession: async () => undefined,
    selectSession: (id) => activeId.set(id),
    renameSession: (id, title) =>
      sessions.set(sessions.getSnapshot().map((s) => (s.id === id ? { ...s, title } : s))),
    toggleSplit: () => undefined,
    attach: async (_id, { onEvent }) => {
      termListeners.add(onEvent);
      onEvent({ type: "ready", restoredHistory: true });
      onEvent({ type: "output", data: "\x1b[32msandbox\x1b[0m $ dev server listening on :3000\r\n$ " });
      onEvent({ type: "replay-complete" });
      return {
        write: (data) => onEvent({ type: "output", data: data === "\r" ? "\r\n$ " : data }),
        resize: () => undefined,
        detach: () => void termListeners.delete(onEvent),
      };
    },
  };

  const reloadListeners = new Set<() => void>();
  const frameUrl = (port: number, path: string): string =>
    `/remote-preview.html?port=${port}&path=${encodeURIComponent(path)}`;
  const preview: PreviewAdapter = {
    kind: "remote",
    servers: cell([{ port: 3000, label: "sandbox" }]),
    whenReady: async () => undefined,
    frameUrl,
    tabUrl: frameUrl,
    locate: () => undefined,
    attachFrame: (frame, port, onEvent, o) =>
      createBridgelessPreviewController({ frame, port, initialPath: o?.initialPath, frameUrl, onEvent }),
    onReloadNeeded: (fn) => (reloadListeners.add(fn), () => void reloadListeners.delete(fn)),
  };

  const geometry = cell<GlobalPaneGeometry>({
    ...DEFAULT_PANE_GEOMETRY,
    explorerWidthPx: 220,
    previewFraction: 0.34,
    terminalHeightPx: 180,
  });
  const mobilePane = cell<WorkbenchPaneId>("editor");
  const layout: LayoutAdapter = {
    geometry,
    setGeometry: geometry.set,
    commitGeometry: () => undefined,
    mobileActivePane: mobilePane,
    setMobileActivePane: mobilePane.set,
  };

  const messages = cell<readonly AgentMessage[]>([
    {
      id: "welcome",
      role: "assistant",
      text: "Ready. Mention files with @ or pick a / command.",
      mentions: [],
    },
  ]);
  const mentionItems: readonly ComposerMentionItem[] = Array.from(files.keys(), (path) => ({
    id: path,
    path,
    label: tabFor(path).label,
    detail: path,
  }));
  const slashCommands: readonly ComposerSlashCommand[] = [
    { id: "fix", name: "fix", description: "Fix diagnostics", insertText: "Fix issues in " },
    { id: "deploy", name: "deploy", description: "Refresh preview", insertText: "Deploy preview for " },
  ];

  return {
    fs,
    documents,
    groups,
    terminal,
    preview,
    layout,
    messages,
    mentionItems,
    slashCommands,
    submitPrompt(text, mentions) {
      const seq = messages.getSnapshot().length + 1;
      const summary = mentions.length > 0 ? mentions.join(", ") : "workspace";
      const next: readonly AgentMessage[] = [
        { id: `u-${seq}`, role: "user", text, mentions },
        { id: `a-${seq}`, role: "assistant", text: `Applied request for ${summary}: "${text}"`, mentions },
      ];
      messages.set(messages.getSnapshot().concat(next));
      for (const fn of termListeners) fn({ type: "output", data: `\r\n[agent] ${summary}\r\n$ ` });
      for (const fn of reloadListeners) fn();
    },
  };
}
