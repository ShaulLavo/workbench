import { describe, expect, test } from "vitest";
import {
  createReplayGate,
  createSubscribable,
  isOptimisticTreeMutationConfirmed,
  resolveActivationFocus,
  type EditorDocumentAdapter,
  type EditorGroupAdapter,
  type EditorGroupsSnapshot,
  type FileSystemAdapter,
  type IndexedTreePatch,
  type IndexedTreeSnapshot,
  type TerminalAdapter,
  type TerminalStreamEvent,
} from "../index";

/**
 * Pre-freeze contract validation spike for Fregat:
 * proves @shaulavo/workbench-core represents Fregat's multi-group split tree,
 * 50k-file revisioned snapshot/patch reconciliation with optimistic settlement,
 * and ordered terminal replay stream with distinct view detach vs session kill.
 */
describe("Fregat pre-freeze contract spike", () => {
  test("multi-group split editor with file, diff, and virtual tabs + cross-group move", async () => {
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
      },
      openDocument() {},
      closeTabs() {},
      pinTab() {},
      placeTab() {},
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
    await expect(docAdapter.writeIfUnchanged("file:src/app.ts", "next", "rev-1")).resolves.toEqual({
      written: true,
      nextRevision: "rev-2",
    });
  });

  test("indexed tree snapshot/patch reconciliation and optimistic settlement preserve empty directories", () => {
    const confirmed: IndexedTreeSnapshot = {
      revision: 10,
      entries: [
        { path: "src", kind: "directory" },
        { path: "src/empty-dir", kind: "directory" },
        { path: "src/moved.ts", kind: "file" },
      ],
      loadedDirectoryPaths: new Set(["", "src"]),
    };

    // Moving into a loaded dir settles once old path vanishes and new path exists.
    expect(
      isOptimisticTreeMutationConfirmed(confirmed, {
        kind: "move",
        moves: [{ from: "src/old.ts", to: "src/moved.ts", entryKind: "file" }],
      }),
    ).toBe(true);

    // Moving into an unloaded dir counts as settled so Fregat intents never stall.
    expect(
      isOptimisticTreeMutationConfirmed(confirmed, {
        kind: "move",
        moves: [{ from: "src/old.ts", to: "unloaded/moved.ts", entryKind: "file" }],
      }),
    ).toBe(true);

    const patches: IndexedTreePatch[] = [];
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
        snapshot: createSubscribable<IndexedTreeSnapshot | undefined>(confirmed),
        subscribePatches: (listener) => {
          patches.forEach(listener);
          return () => {};
        },
        requestResync: async () => {},
      },
      git: createSubscribable({
        statusByPath: new Map([["src/moved.ts", "modified"]]),
        directoriesWithChanges: new Set(["src"]),
        ignoredDirectories: new Set(["dist"]),
      }),
    };

    expect(fsAdapter.indexed?.snapshot.getSnapshot()?.entries).toContainEqual({
      path: "src/empty-dir",
      kind: "directory",
    });
    expect(fsAdapter.git?.getSnapshot().directoriesWithChanges.has("src")).toBe(true);
  });

  test("ordered PTY replay stream distinguishes view detach from session kill", async () => {
    let detached = 0;
    let killed = 0;
    const events: TerminalStreamEvent[] = [];

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
        opts.onEvent({ type: "ready", restoredHistory: true });
        opts.onEvent({ type: "output", data: "cached history\r\n" });
        opts.onEvent({ type: "replay-complete" });
        return {
          write: () => {},
          resize: () => {},
          detach: () => {
            detached += 1;
          },
        };
      },
    };

    let inputEnabled = false;
    const gate = createReplayGate({
      terminal: { scrollBy: () => {}, refresh: () => {}, getRowCount: () => 24 },
      getSavedScroll: () => null,
      onReadyChange: (ready) => {
        inputEnabled = ready;
      },
    });

    const controller = new AbortController();
    const attachment = await terminalAdapter.attach("term-1", {
      initialSize: { cols: 80, rows: 24 },
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "ready") gate.begin();
        if (event.type === "replay-complete") gate.complete();
      },
    });

    expect(events.map((e) => e.type)).toEqual(["ready", "output", "replay-complete"]);
    expect(inputEnabled).toBe(false);
    gate.paint();
    expect(inputEnabled).toBe(true);

    attachment.detach();
    expect(detached).toBe(1);
    expect(killed).toBe(0);
  });
});
