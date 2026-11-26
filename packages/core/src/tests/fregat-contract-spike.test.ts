import { describe, expect, test } from "vitest";
import {
  createReplayGate,
  createSubscribable,
  isOptimisticTreeMutationConfirmed,
  resolveActivationFocus,
  type EditorDocumentAdapter,
  type EditorGroupAdapter,
  type EditorGroupNode,
  type EditorGroupsSnapshot,
  type EditorGroupTreeNode,
  type FileSystemAdapter,
  type IndexedTreePatch,
  type IndexedTreeSnapshot,
  type TabPlacement,
  type TerminalAdapter,
  type TerminalStreamEvent,
} from "../index";

function updateGroup(
  node: EditorGroupTreeNode,
  groupId: string,
  updater: (group: EditorGroupNode) => EditorGroupNode,
): EditorGroupTreeNode {
  if (node.kind === "group") return node.id === groupId ? updater(node) : node;
  const [first, second, ...rest] = node.children;
  return {
    ...node,
    children: [
      { ...first, node: updateGroup(first.node, groupId, updater) },
      { ...second, node: updateGroup(second.node, groupId, updater) },
      ...rest.map((child) => ({ ...child, node: updateGroup(child.node, groupId, updater) })),
    ],
  };
}

function findGroup(node: EditorGroupTreeNode, groupId: string): EditorGroupNode | undefined {
  if (node.kind === "group") return node.id === groupId ? node : undefined;
  for (const child of node.children) {
    const found = findGroup(child.node, groupId);
    if (found) return found;
  }
  return undefined;
}

function applyIndexedPatch(
  snapshot: IndexedTreeSnapshot,
  patch: IndexedTreePatch,
): { readonly snapshot: IndexedTreeSnapshot; readonly needsResync: boolean } {
  if (patch.kind === "reset" || patch.baseRevision !== snapshot.revision) {
    return { snapshot, needsResync: true };
  }
  if (patch.kind === "create") {
    return {
      needsResync: false,
      snapshot: {
        ...snapshot,
        revision: patch.nextRevision,
        entries: snapshot.entries.concat([{ path: patch.path, kind: patch.entryKind }]),
      },
    };
  }
  if (patch.kind === "delete") {
    return {
      needsResync: false,
      snapshot: {
        ...snapshot,
        revision: patch.nextRevision,
        entries: snapshot.entries.filter((e) => e.path !== patch.path),
      },
    };
  }
  if (patch.kind === "move") {
    const moveMap = new Map(patch.moves.map((m) => [m.from, m.to]));
    return {
      needsResync: false,
      snapshot: {
        ...snapshot,
        revision: patch.nextRevision,
        entries: snapshot.entries.map((e) => {
          const target = moveMap.get(e.path);
          return target ? { ...e, path: target } : e;
        }),
      },
    };
  }
  return {
    needsResync: false,
    snapshot: {
      ...snapshot,
      revision: patch.nextRevision,
      entries: snapshot.entries.concat([{ path: patch.to, kind: patch.entryKind }]),
    },
  };
}

/**
 * Pre-freeze contract validation spike for Fregat:
 * exercises multi-group split mutations (placeTab move/copy), revisioned indexed tree patches
 * with root-directory settlement and gap resync, and ordered terminal replay + reconnect.
 */
describe("Fregat pre-freeze contract spike", () => {
  test("multi-group split editor supports file/diff tabs, selectTab by ID, and real cross-group placeTab move/copy", async () => {
    const groupsStore = createSubscribable<EditorGroupsSnapshot>({
      activeGroupId: "group:left",
      root: {
        kind: "split",
        id: "split:root",
        axis: "horizontal",
        children: [
          {
            size: 50,
            node: {
              kind: "group",
              id: "group:left",
              selectedTabId: "tab:diff-1",
              tabs: [
                {
                  id: "tab:file-1",
                  documentId: "file:src/app.ts",
                  kind: "file",
                  path: "src/app.ts",
                  label: "app.ts",
                  title: "src/app.ts",
                },
                {
                  id: "tab:diff-1",
                  documentId: "diff:src/app.ts",
                  kind: "diff",
                  path: "src/app.ts",
                  label: "app.ts (Changes)",
                  title: "src/app.ts (Working Tree)",
                },
              ],
            },
          },
          {
            size: 50,
            node: {
              kind: "group",
              id: "group:right",
              selectedTabId: null,
              tabs: [],
            },
          },
        ],
      },
    });

    const selectedCalls: Array<{ groupId: string; tabId: string; focus: boolean }> = [];
    const groupAdapter: EditorGroupAdapter = {
      groups: groupsStore,
      selectTab(groupId, tabId, focus) {
        selectedCalls.push({ groupId, tabId, focus: focus.shouldFocusEditor });
        groupsStore.set((prev) => ({
          activeGroupId: groupId,
          root: updateGroup(prev.root, groupId, (g) => ({ ...g, selectedTabId: tabId })),
        }));
      },
      openDocument() {},
      closeTabs() {},
      pinTab() {},
      placeTab(placement: TabPlacement) {
        if (placement.target.kind !== "group") return;
        const targetGroupId = placement.target.groupId;
        groupsStore.set((prev) => {
          const sourceGroup = findGroup(prev.root, "group:left");
          const tab = sourceGroup?.tabs.find((t) => t.id === placement.tabId);
          if (!tab) return prev;
          let nextRoot = prev.root;
          if (placement.mode === "move") {
            nextRoot = updateGroup(nextRoot, "group:left", (g) => {
              const remaining = g.tabs.filter((t) => t.id !== tab.id);
              return { ...g, tabs: remaining, selectedTabId: remaining[0]?.id ?? null };
            });
          }
          const placedTab = placement.mode === "copy" ? { ...tab, id: `${tab.id}:copy` } : tab;
          nextRoot = updateGroup(nextRoot, targetGroupId, (g) => ({
            ...g,
            tabs: g.tabs.concat([placedTab]),
            selectedTabId: placedTab.id,
          }));
          return { activeGroupId: targetGroupId, root: nextRoot };
        });
      },
    };

    const docAdapter: EditorDocumentAdapter = {
      getConflict: () => createSubscribable(undefined),
      loadDocument: async (id) => ({
        text: `// ${id}\n`,
        revision: "rev-1",
        byteLength: 16,
      }),
      writeIfUnchanged: async (_id, _text, expected) =>
        expected === "rev-1"
          ? { written: true, nextRevision: "rev-2" }
          : { written: false, currentText: "// newer\n", currentRevision: "rev-2" },
      save: async () => {},
    };

    const touchTap = resolveActivationFocus(undefined, "auto", { coarseViewport: true });
    groupAdapter.selectTab("group:left", "tab:diff-1", touchTap);
    expect(selectedCalls).toEqual([{ groupId: "group:left", tabId: "tab:diff-1", focus: false }]);

    // Copy diff tab to right group, then move file tab to right group.
    groupAdapter.placeTab({
      tabId: "tab:diff-1",
      mode: "copy",
      target: { kind: "group", groupId: "group:right" },
    });
    groupAdapter.placeTab({
      tabId: "tab:file-1",
      mode: "move",
      target: { kind: "group", groupId: "group:right" },
    });

    const snap = groupsStore.getSnapshot();
    expect(findGroup(snap.root, "group:left")?.tabs.map((t) => t.id)).toEqual(["tab:diff-1"]);
    expect(findGroup(snap.root, "group:right")?.tabs.map((t) => t.id)).toEqual([
      "tab:diff-1:copy",
      "tab:file-1",
    ]);

    await expect(docAdapter.writeIfUnchanged("file:src/app.ts", "next", "rev-1")).resolves.toEqual({
      written: true,
      nextRevision: "rev-2",
    });
    await expect(docAdapter.writeIfUnchanged("file:src/app.ts", "stale", "rev-0")).resolves.toEqual({
      written: false,
      currentText: "// newer\n",
      currentRevision: "rev-2",
    });
  });

  test("indexed tree patch stream enforces root-loaded settlement, preserves empty dirs, and triggers gap resync", async () => {
    const initial: IndexedTreeSnapshot = {
      revision: 10,
      entries: [
        { path: "src", kind: "directory" },
        { path: "src/empty-dir", kind: "directory" },
        { path: "src/moved.ts", kind: "file" },
      ],
      // Deliberately omit "" to prove root is ALWAYS treated as loaded (matching Fregat).
      loadedDirectoryPaths: new Set(["src"]),
    };

    // Pending root-level create must NOT settle early when snapshot omits "" from loadedDirectoryPaths.
    expect(
      isOptimisticTreeMutationConfirmed(initial, {
        kind: "create",
        path: "README.md",
        entryKind: "file",
      }),
    ).toBe(false);

    // Moving into an unloaded subdirectory counts as settled so Fregat intents do not stall.
    expect(
      isOptimisticTreeMutationConfirmed(initial, {
        kind: "move",
        moves: [{ from: "src/old.ts", to: "unloaded/moved.ts", entryKind: "file" }],
      }),
    ).toBe(true);

    const snapshotStore = createSubscribable<IndexedTreeSnapshot | undefined>(initial);
    const patchListeners = new Set<(patch: IndexedTreePatch) => void>();
    let resyncCount = 0;

    const fsAdapter: FileSystemAdapter = {
      workspaceId: "fregat:main",
      writable: createSubscribable(true),
      listFiles: async () => ["src/moved.ts"],
      readText: async () => "export {};\n",
      createFile: async () => {},
      createDirectory: async () => {},
      move: async () => {},
      remove: async () => {},
      indexed: {
        snapshot: snapshotStore,
        subscribePatches: (listener) => {
          patchListeners.add(listener);
          return () => patchListeners.delete(listener);
        },
        requestResync: async () => {
          resyncCount += 1;
        },
      },
      git: createSubscribable({
        statusByPath: new Map([["src/moved.ts", "modified"]]),
        directoriesWithChanges: new Set(["src"]),
        ignoredDirectories: new Set(["dist"]),
      }),
    };

    const unsubscribe = fsAdapter.indexed!.subscribePatches((patch) => {
      const current = snapshotStore.getSnapshot();
      if (!current) return;
      const result = applyIndexedPatch(current, patch);
      if (result.needsResync) {
        void fsAdapter.indexed!.requestResync();
      } else {
        snapshotStore.set(result.snapshot);
      }
    });

    // Apply in-order patch creating root README.md -> now root create settles.
    for (const listener of patchListeners) {
      listener({ kind: "create", baseRevision: 10, nextRevision: 11, path: "README.md", entryKind: "file" });
    }
    expect(
      isOptimisticTreeMutationConfirmed(snapshotStore.getSnapshot()!, {
        kind: "create",
        path: "README.md",
        entryKind: "file",
      }),
    ).toBe(true);

    // Out-of-order revision gap triggers resync.
    for (const listener of patchListeners) {
      listener({ kind: "delete", baseRevision: 99, nextRevision: 100, path: "README.md" });
    }
    expect(resyncCount).toBe(1);
    expect(snapshotStore.getSnapshot()?.entries).toContainEqual({
      path: "src/empty-dir",
      kind: "directory",
    });
    expect(fsAdapter.git?.getSnapshot().directoriesWithChanges.has("src")).toBe(true);
    unsubscribe();
  });

  test("ordered PTY replay stream handles reconnects and distinguishes view detach from session kill", async () => {
    let detached = 0;
    let killed = 0;
    let emitEvent: ((event: TerminalStreamEvent) => void) | undefined;

    const terminalAdapter: TerminalAdapter = {
      sessions: createSubscribable([{ id: "term-1", title: "zsh", status: "running" }]),
      activeId: createSubscribable<string | undefined>("term-1"),
      splitId: createSubscribable<string | undefined>(undefined),
      createSession: async () => "term-1",
      closeSession: async () => {
        killed += 1;
      },
      selectSession: () => {},
      renameSession: () => {},
      toggleSplit: () => {},
      attach: async (_id, opts) => {
        emitEvent = opts.onEvent;
        return {
          write: () => {},
          resize: () => {},
          detach: () => {
            detached += 1;
            emitEvent = undefined;
          },
        };
      },
    };

    const scrolled: number[] = [];
    let inputEnabled = false;
    const gate = createReplayGate({
      terminal: {
        scrollBy: (delta) => scrolled.push(delta),
        refresh: () => {},
        getRowCount: () => 24,
      },
      getSavedScroll: () => ({ total: 200, length: 24, offset: 150 }),
      onReadyChange: (ready) => {
        inputEnabled = ready;
      },
    });

    const controller = new AbortController();
    const attachment = await terminalAdapter.attach("term-1", {
      initialSize: { cols: 80, rows: 24 },
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "ready") gate.begin();
        if (event.type === "replay-complete") gate.complete();
        if (event.type === "disconnected" && !event.willReconnect) gate.close();
      },
    });

    // Initial replay
    emitEvent!({ type: "ready", restoredHistory: true });
    emitEvent!({ type: "output", data: "cached history\r\n" });
    emitEvent!({ type: "replay-complete" });
    expect(inputEnabled).toBe(false);
    expect(scrolled).toEqual([-26]);
    gate.paint();
    expect(inputEnabled).toBe(true);

    // Reconnect re-arms replay gate without double-restoring saved scroll
    emitEvent!({ type: "disconnected", willReconnect: true });
    emitEvent!({ type: "ready" });
    expect(inputEnabled).toBe(false);
    emitEvent!({ type: "replay-complete" });
    gate.paint();
    expect(inputEnabled).toBe(true);
    expect(scrolled).toEqual([-26]);

    attachment.detach();
    expect(detached).toBe(1);
    expect(killed).toBe(0);
  });
});
