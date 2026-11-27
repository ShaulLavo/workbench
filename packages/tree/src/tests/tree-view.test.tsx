import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  DirectoryLoadState,
  FileSystemAdapter,
  FileTreeGitState,
  Subscribable,
} from "@shaulavo/workbench-core";
import { WorkbenchPortalProvider } from "@shaulavo/workbench-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTreeModel, prepareFileTreeInput } from "../index";
import { FileTreeView, type FileTreeViewHandle } from "../react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let activeRoot: Root | null = null;
let activeHost: HTMLDivElement | null = null;
let heightSpy: ReturnType<typeof vi.spyOn> | null = null;
let widthSpy: ReturnType<typeof vi.spyOn> | null = null;

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

function mount(element: React.ReactElement): HTMLDivElement {
  activeHost = document.createElement("div");
  document.body.appendChild(activeHost);
  activeRoot = createRoot(activeHost);
  act(() => {
    activeRoot?.render(<WorkbenchPortalProvider>{element}</WorkbenchPortalProvider>);
  });
  return activeHost;
}

beforeEach(() => {
  heightSpy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(360);
  widthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(280);
});

afterEach(() => {
  act(() => {
    activeRoot?.unmount();
  });
  activeRoot = null;
  activeHost?.remove();
  activeHost = null;
  heightSpy?.mockRestore();
  widthSpy?.mockRestore();
});

describe("@shaulavo/workbench-tree React view", () => {
  it("renders virtualized rows, navigates with keyboard moving real DOM focus, and opens files", () => {
    const git: FileTreeGitState = {
      statusByPath: new Map([["src/App.tsx", "modified"]]),
      directoriesWithChanges: new Set(["src"]),
      ignoredDirectories: new Set(["node_modules"]),
    };
    const model = new FileTreeModel({
      paths: ["src/App.tsx", "CLAUDE.md", "node_modules/dep/index.js"],
      initialExpanded: ["src"],
      git,
    });
    const onOpenFile = vi.fn();
    const host = mount(<FileTreeView model={model} onOpenFile={onOpenFile} />);

    const claudeRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-CLAUDE.md"]');
    const srcRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-src"]');
    const appRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-src/App.tsx"]');
    expect(claudeRow).not.toBeNull();
    expect(srcRow?.querySelector('[data-wb-git-dot="true"]')).not.toBeNull();
    expect(appRow?.querySelector(".wb-tree-git-badge")?.textContent).toBe("M");

    act(() => {
      srcRow?.click();
    });
    // Clicking expanded src collapses it; click again to re-expand.
    expect(model.getSnapshot().expanded.has("src")).toBe(false);
    act(() => {
      srcRow?.click();
    });
    expect(model.getSnapshot().expanded.has("src")).toBe(true);

    const scroller = host.querySelector<HTMLElement>("[data-wb-tree-scroller]");
    act(() => {
      scroller?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(model.getSnapshot().focusedPath).toBe("src/App.tsx");
    expect(document.activeElement).toBe(host.querySelector('[data-testid="wb-tree-row-src/App.tsx"]'));

    act(() => {
      scroller?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onOpenFile).toHaveBeenCalledWith("src/App.tsx", {
      shouldFocusEditor: true,
      origin: "keyboard",
    });
  });

  it("seeds inline filter on typing and respects reactive adapter.writable for F2 rename", () => {
    const writableSub = createSubscribable(false);
    const move = vi.fn(async () => {});
    const adapter: FileSystemAdapter = {
      workspaceId: "test-view-indexed",
      writable: writableSub,
      indexed: {
        snapshot: createSubscribable({
          revision: 1,
          entries: [
            { path: "README.md", kind: "file" as const },
            { path: "CLAUDE.md", kind: "file" as const },
          ],
          loadedDirectoryPaths: new Set([""]),
        }),
        subscribePatches: () => () => {},
        requestResync: async () => {},
      },
      listFiles: async () => ["README.md", "CLAUDE.md"],
      readText: async () => "",
      createFile: async () => {},
      createDirectory: async () => {},
      move,
      remove: async () => {},
    };

    const model = new FileTreeModel();
    const host = mount(<FileTreeView model={model} adapter={adapter} />);
    const scroller = host.querySelector<HTMLElement>("[data-wb-tree-scroller]");

    act(() => {
      host.querySelector<HTMLElement>('[data-testid="wb-tree-row-README.md"]')?.click();
    });
    // Read-only initially: F2 must NOT open rename input.
    act(() => {
      scroller?.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    });
    expect(host.querySelector('[data-testid="wb-tree-inline-input"]')).toBeNull();

    // Flip adapter.writable reactively to true: F2 now opens inline rename!
    act(() => {
      writableSub.set(true);
    });
    act(() => {
      scroller?.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
    });
    const input = host.querySelector<HTMLInputElement>('[data-testid="wb-tree-inline-input"]');
    expect(input).not.toBeNull();

    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector('[data-testid="wb-tree-inline-input"]')).toBeNull();

    // Typing a printable key seeds FilterField directly.
    act(() => {
      scroller?.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    });
    expect(model.getSnapshot().filter).toBe("c");
  });

  it("renders lazy error row and retries directory load when Retry button is clicked", async () => {
    const rootState = createSubscribable<DirectoryLoadState>({
      status: "loaded",
      entries: [{ name: "remote", kind: "directory" }],
    });
    const remoteState = createSubscribable<DirectoryLoadState>({
      status: "error",
      message: "Network timeout",
      retryable: true,
    });
    const loadDirectory = vi.fn(async (dir: string) => {
      if (dir === "remote") {
        remoteState.set({ status: "loaded", entries: [{ name: "recovered.ts", kind: "file" }] });
      }
    });

    const adapter: FileSystemAdapter = {
      workspaceId: "test-view-lazy",
      writable: createSubscribable(true),
      lazy: {
        getDirectoryState: (dir) => (dir === "" ? rootState : remoteState),
        loadDirectory,
        subscribeInvalidation: () => () => {},
      },
      listFiles: async () => [],
      readText: async () => "",
      createFile: async () => {},
      createDirectory: async () => {},
      move: async () => {},
      remove: async () => {},
    };

    const model = new FileTreeModel({ initialExpanded: ["remote"] });
    const host = mount(<FileTreeView model={model} adapter={adapter} />);

    const retryBtn = host.querySelector<HTMLButtonElement>('[data-testid="wb-tree-retry-remote"]');
    expect(retryBtn).not.toBeNull();

    await act(async () => {
      retryBtn?.click();
      await Promise.resolve();
    });
    expect(loadDirectory).toHaveBeenCalledWith("remote", { force: true });
    expect(host.querySelector('[data-testid="wb-tree-row-remote/recovered.ts"]')).not.toBeNull();
  });

  it("exposes an initial Tab stop, transfers focus on compact collapse, rechecks writability at commit, and executes touch long-press drop", async () => {
    vi.useFakeTimers();
    try {
      const writableSub = createSubscribable(true);
      const move = vi.fn(async () => {});
      const adapter: FileSystemAdapter = {
        workspaceId: "test-view-guards",
        writable: writableSub,
        indexed: {
          snapshot: createSubscribable({
            revision: 1,
            entries: [
              { path: "a/b/item.ts", kind: "file" as const },
              { path: "dest", kind: "directory" as const },
              { path: "note.md", kind: "file" as const },
            ],
            loadedDirectoryPaths: new Set(["", "a", "a/b", "dest"]),
          }),
          subscribePatches: () => () => {},
          requestResync: async () => {},
        },
        listFiles: async () => [],
        readText: async () => "",
        createFile: async () => {},
        createDirectory: async () => {},
        move,
        remove: async () => {},
      };

      const model = new FileTreeModel({ initialExpanded: ["a", "a/b"] });
      const host = mount(<FileTreeView model={model} adapter={adapter} />);

      // Initial populated tree exposes exactly one Tab stop on the first entry row.
      const tabStops = host.querySelectorAll('[tabindex="0"]');
      expect(tabStops).toHaveLength(1);
      expect(tabStops[0]?.getAttribute("data-path")).toBe("a/b");

      // ArrowLeft on expanded compact chain `a/b` collapses `a` and moves focus to `a`.
      const compactRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-a/b"]');
      const scroller = host.querySelector<HTMLElement>("[data-wb-tree-scroller]");
      act(() => {
        compactRow?.focus();
      });
      act(() => {
        scroller?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      });
      expect(model.getSnapshot().focusedPath).toBe("a");
      expect(document.activeElement).toBe(host.querySelector('[data-testid="wb-tree-row-a"]'));

      // Opening rename while writable, flipping read-only before Enter, must block adapter.move.
      act(() => {
        host.querySelector<HTMLElement>('[data-testid="wb-tree-row-note.md"]')?.click();
      });
      act(() => {
        scroller?.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
      });
      const input = host.querySelector<HTMLInputElement>('[data-testid="wb-tree-inline-input"]');
      expect(input).not.toBeNull();
      act(() => {
        writableSub.set(false);
      });
      act(() => {
        if (input) {
          input.value = "blocked.md";
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        }
      });
      expect(move).not.toHaveBeenCalled();

      // Re-enable writable and execute pointer-driven touch long-press drag of note.md onto dest.
      act(() => {
        writableSub.set(true);
      });
      const noteRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-note.md"]');
      const destRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-dest"]');
      expect(noteRow).not.toBeNull();
      expect(destRow).not.toBeNull();

      const elementFromPointSpy = vi.spyOn(document, "elementFromPoint").mockReturnValue(destRow as Element);

      act(() => {
        noteRow?.dispatchEvent(
          new PointerEvent("pointerdown", {
            pointerId: 7,
            pointerType: "touch",
            clientX: 20,
            clientY: 80,
            bubbles: true,
          }),
        );
      });
      act(() => {
        vi.advanceTimersByTime(450);
      });
      act(() => {
        noteRow?.dispatchEvent(
          new PointerEvent("pointermove", {
            pointerId: 7,
            pointerType: "touch",
            clientX: 20,
            clientY: 40,
            bubbles: true,
          }),
        );
      });
      await act(async () => {
        noteRow?.dispatchEvent(
          new PointerEvent("pointerup", {
            pointerId: 7,
            pointerType: "touch",
            clientX: 20,
            clientY: 40,
            bubbles: true,
          }),
        );
        await Promise.resolve();
      });
      expect(move).toHaveBeenCalledTimes(1);
      expect(move).toHaveBeenCalledWith("note.md", "dest/note.md");
      elementFromPointSpy.mockRestore();

      // Touch drag hovered over dest but released outside tree MUST NOT commit a move.
      move.mockClear();
      const movedNoteRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-dest/note.md"]');
      const outsideSpy = vi
        .spyOn(document, "elementFromPoint")
        .mockReturnValueOnce(host.querySelector('[data-testid="wb-tree-row-a"]') as Element)
        .mockReturnValueOnce(document.body);
      act(() => {
        movedNoteRow?.dispatchEvent(
          new PointerEvent("pointerdown", {
            pointerId: 8,
            pointerType: "touch",
            clientX: 20,
            clientY: 80,
            bubbles: true,
          }),
        );
      });
      act(() => {
        vi.advanceTimersByTime(450);
      });
      act(() => {
        movedNoteRow?.dispatchEvent(
          new PointerEvent("pointermove", {
            pointerId: 8,
            pointerType: "touch",
            clientX: 20,
            clientY: 20,
            bubbles: true,
          }),
        );
      });
      await act(async () => {
        movedNoteRow?.dispatchEvent(
          new PointerEvent("pointerup", {
            pointerId: 8,
            pointerType: "touch",
            clientX: 500,
            clientY: 500,
            bubbles: true,
          }),
        );
        await Promise.resolve();
      });
      expect(move).not.toHaveBeenCalled();
      outsideSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a batch delete mid-loop when adapter.writable turns false", async () => {
    const writableSub = createSubscribable(true);
    const removed: string[] = [];
    const adapter: FileSystemAdapter = {
      workspaceId: "test-batch-writable",
      writable: writableSub,
      indexed: {
        snapshot: createSubscribable({
          revision: 1,
          entries: [
            { path: "one.ts", kind: "file" as const },
            { path: "two.ts", kind: "file" as const },
          ],
          loadedDirectoryPaths: new Set([""]),
        }),
        subscribePatches: () => () => {},
        requestResync: async () => {},
      },
      listFiles: async () => [],
      readText: async () => "",
      createFile: async () => {},
      createDirectory: async () => {},
      move: async () => {},
      async remove(target) {
        removed.push(target);
        writableSub.set(false);
      },
    };

    const model = new FileTreeModel();
    const host = mount(<FileTreeView model={model} adapter={adapter} />);
    const scroller = host.querySelector<HTMLElement>("[data-wb-tree-scroller]");

    act(() => {
      model.select("one.ts", "replace", "keyboard");
      model.select("two.ts", "range", "keyboard");
    });
    act(() => {
      scroller?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    const confirmBtn = host.querySelector<HTMLButtonElement>('[data-testid="wb-confirm-accept"]');
    expect(confirmBtn).not.toBeNull();

    await act(async () => {
      confirmBtn?.click();
      await Promise.resolve();
    });
    expect(removed).toEqual(["one.ts"]);
    expect(model.index.hasPath("two.ts")).toBe(true);
  });

  it("stops a batch delete mid-loop when the readOnly prop flips to true", async () => {
    const removed: string[] = [];
    let flipReadOnly: (() => void) | undefined;
    const adapter: FileSystemAdapter = {
      workspaceId: "test-batch-readonly-prop",
      writable: createSubscribable(true),
      indexed: {
        snapshot: createSubscribable({
          revision: 1,
          entries: [
            { path: "alpha.ts", kind: "file" as const },
            { path: "beta.ts", kind: "file" as const },
          ],
          loadedDirectoryPaths: new Set([""]),
        }),
        subscribePatches: () => () => {},
        requestResync: async () => {},
      },
      listFiles: async () => [],
      readText: async () => "",
      createFile: async () => {},
      createDirectory: async () => {},
      move: async () => {},
      async remove(target) {
        removed.push(target);
        flipReadOnly?.();
      },
    };

    const model = new FileTreeModel();
    const host = mount(<FileTreeView model={model} adapter={adapter} readOnly={false} />);
    flipReadOnly = () => {
      act(() => {
        activeRoot?.render(
          <WorkbenchPortalProvider>
            <FileTreeView model={model} adapter={adapter} readOnly />
          </WorkbenchPortalProvider>,
        );
      });
    };

    const scroller = host.querySelector<HTMLElement>("[data-wb-tree-scroller]");
    act(() => {
      model.select("alpha.ts", "replace", "keyboard");
      model.select("beta.ts", "range", "keyboard");
    });
    act(() => {
      scroller?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    const confirmBtn = host.querySelector<HTMLButtonElement>('[data-testid="wb-confirm-accept"]');
    expect(confirmBtn).not.toBeNull();

    await act(async () => {
      confirmBtn?.click();
      await Promise.resolve();
    });
    expect(removed).toEqual(["alpha.ts"]);
    expect(model.index.hasPath("beta.ts")).toBe(true);
  });

  it("resets canvas and row transforms cleanly when toggling directDomUpdates at runtime", () => {
    const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-wb-tree-scroller") ? 260 : 26;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return 260;
      },
    });

    try {
      const model = new FileTreeModel({ paths: ["a.ts", "b.ts", "c.ts"] });
      const host = mount(<FileTreeView model={model} directDomUpdates={true} showFilter={false} />);
      const directSlots = host.querySelectorAll<HTMLDivElement>(".wb-tree-slot");
      expect(directSlots.length).toBe(3);
      expect(directSlots[1]?.style.transform).toContain("translate3d(0, 26px, 0)");

      act(() => {
        activeRoot?.render(
          <WorkbenchPortalProvider>
            <FileTreeView model={model} directDomUpdates={false} showFilter={false} />
          </WorkbenchPortalProvider>,
        );
      });
      const reactSlots = host.querySelectorAll<HTMLDivElement>(".wb-tree-slot");
      expect(reactSlots[1]?.style.transform).toBe("translateY(26px)");

      act(() => {
        activeRoot?.render(
          <WorkbenchPortalProvider>
            <FileTreeView model={model} directDomUpdates={true} showFilter={false} />
          </WorkbenchPortalProvider>,
        );
      });
      const backOnSlots = host.querySelectorAll<HTMLDivElement>(".wb-tree-slot");
      expect(backOnSlots[1]?.style.transform).toContain("translate3d(0, 26px, 0)");
    } finally {
      if (origClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", origClientHeight);
      if (origClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", origClientWidth);
    }
  });

  it("supports imperative handleRef, rowHeight, decorations, row element tracking, and delegated menu/delete/mutations", async () => {
    const model = new FileTreeModel({
      paths: ["src/a.ts", "src/b.ts", "README.md"],
      initialExpanded: ["src"],
    });
    const handleRef = createRef<FileTreeViewHandle>();
    const onRequestContextMenu = vi.fn();
    const onRequestDelete = vi.fn();
    const onCreate = vi.fn();
    const onRename = vi.fn();
    const onExpandChange = vi.fn();
    const onSelectionChange = vi.fn();
    const onScrollTopChange = vi.fn();
    const mountedElements = new Map<string, HTMLElement>();

    const host = mount(
      <FileTreeView
        model={model}
        handleRef={handleRef}
        rowHeight={20}
        initialScrollTop={12}
        onScrollTopChange={onScrollTopChange}
        activePath="src/a.ts"
        loadingPaths={new Set(["src/b.ts"])}
        renderRowDecoration={(row) =>
          row.path === "src" ? <span data-testid="custom-dec">loading</span> : null
        }
        onRowElementChange={(path, element) => {
          if (element) mountedElements.set(path, element);
          else mountedElements.delete(path);
        }}
        onRequestContextMenu={onRequestContextMenu}
        onRequestDelete={onRequestDelete}
        onCreate={onCreate}
        onRename={onRename}
        onExpandChange={onExpandChange}
        onSelectionChange={onSelectionChange}
      />,
    );

    // Row height override & initialScrollTop
    const firstSlot = host.querySelector<HTMLDivElement>(".wb-tree-slot");
    const viewportWrap = host.querySelector<HTMLDivElement>(".wb-tree-viewport-wrap");
    expect(firstSlot?.style.height).toBe("20px");
    expect(viewportWrap?.style.getPropertyValue("--wb-tree-row-height")).toBe("20px");
    expect(handleRef.current?.getScrollElement()?.scrollTop).toBe(12);

    // Active, loading, custom decoration, and row element registration
    const aRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-src/a.ts"]');
    const bRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-src/b.ts"]');
    expect(aRow?.getAttribute("aria-current")).toBe("true");
    expect(aRow?.getAttribute("data-active")).toBe("true");
    expect(bRow?.getAttribute("data-loading")).toBe("true");
    expect(host.querySelector('[data-testid="custom-dec"]')?.textContent).toBe("loading");
    expect(mountedElements.get("src/a.ts")).toBe(aRow);

    // Context menu delegation for row and root background
    act(() => {
      aRow?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 60 }));
    });
    expect(onRequestContextMenu).toHaveBeenCalledTimes(1);
    expect(onRequestContextMenu.mock.calls[0]?.[0]?.path).toBe("src/a.ts");
    expect(onRequestContextMenu.mock.calls[0]?.[1]).toEqual({ x: 40, y: 60 });

    const scroller = host.querySelector<HTMLElement>("[data-wb-tree-scroller]");
    act(() => {
      scroller?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 180 }));
    });
    expect(onRequestContextMenu).toHaveBeenCalledTimes(2);
    expect(onRequestContextMenu.mock.calls[1]?.[0]).toBeNull();

    // Delegated delete via keyboard
    act(() => {
      scroller?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(onRequestDelete).toHaveBeenCalledWith(["src/a.ts"]);

    // Imperative startCreate -> delegates to onCreate
    act(() => {
      handleRef.current?.startCreate("src", "file");
    });
    const draftInput = host.querySelector<HTMLInputElement>('[data-testid="wb-tree-inline-input"]');
    expect(draftInput).not.toBeNull();
    await act(async () => {
      if (draftInput) {
        draftInput.value = "c.ts";
        draftInput.dispatchEvent(new Event("input", { bubbles: true }));
        draftInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
      await Promise.resolve();
    });
    expect(onCreate).toHaveBeenCalledWith("src", "file", "c.ts");

    // Imperative startRename -> delegates to onRename
    act(() => {
      handleRef.current?.startRename("README.md");
    });
    const renameInput = host.querySelector<HTMLInputElement>('[data-testid="wb-tree-inline-input"]');
    await act(async () => {
      if (renameInput) {
        renameInput.value = "NOTES.md";
        renameInput.dispatchEvent(new Event("input", { bubbles: true }));
        renameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      }
      await Promise.resolve();
    });
    expect(onRename).toHaveBeenCalledWith("README.md", "NOTES.md");

    // Cmd+A selects all, collapseAll collapses expanded folders, replacePreparedInput swaps O(1)
    act(() => {
      scroller?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
    });
    expect(model.getSelectedPaths().length).toBe(4);
    expect(onSelectionChange).toHaveBeenCalled();

    act(() => {
      handleRef.current?.collapseAll();
    });
    expect(model.getExpandedPaths()).toEqual([]);

    act(() => {
      model.replacePreparedInput(prepareFileTreeInput(["fresh/index.ts"]));
    });
    expect(model.index.hasPath("fresh/index.ts")).toBe(true);
    expect(model.index.hasPath("README.md")).toBe(false);

    // Imperative focusPath expands ancestors and focuses row
    act(() => {
      expect(handleRef.current?.focusPath("fresh/index.ts")).toBe(true);
    });
    expect(model.getSnapshot().expanded.has("fresh")).toBe(true);
    expect(model.getSnapshot().focusedPath).toBe("fresh/index.ts");
  });

  it("keeps drafts visible, routes delegated errors to onError, rejects filtered focusPath, enforces touch canDrag, cleans external dragleave, and renames clicked compact segment", async () => {
    vi.useFakeTimers();
    try {
      const model = new FileTreeModel({
        paths: ["a/b/leaf.ts", "dir/child.ts", "README.md"],
        initialExpanded: ["a", "a/b"],
      });
      const handleRef = createRef<FileTreeViewHandle>();
      const onError = vi.fn();
      const onCreate = vi.fn(async () => {
        throw new Error("create boom");
      });
      const onRename = vi.fn(async () => {
        throw new Error("rename boom");
      });
      const onMove = vi.fn(async () => {
        throw new Error("move boom");
      });
      const canDrag = vi.fn((paths: readonly string[]) => !paths.includes("README.md"));
      const onExternalDrop = vi.fn();

      const host = mount(
        <FileTreeView
          model={model}
          handleRef={handleRef}
          onCreate={onCreate}
          onRename={onRename}
          onMove={onMove}
          onError={onError}
          canDrag={canDrag}
          onExternalDrop={onExternalDrop}
        />,
      );

      // 1. startRename on a collapsed child expands ancestors so the input is visible.
      act(() => {
        handleRef.current?.startRename("dir/child.ts");
      });
      expect(model.getSnapshot().expanded.has("dir")).toBe(true);
      const renameInput = host.querySelector<HTMLInputElement>('[data-testid="wb-tree-inline-input"]');
      expect(renameInput).not.toBeNull();
      await act(async () => {
        if (renameInput) {
          renameInput.value = "renamed.ts";
          renameInput.dispatchEvent(new Event("input", { bubbles: true }));
          renameInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        }
        await Promise.resolve();
      });
      expect(onRename).toHaveBeenCalledWith("dir/child.ts", "dir/renamed.ts");
      expect(onError).toHaveBeenCalledWith("Unable to rename child.ts", expect.any(Error));

      // 2. focusPath on a filtered-out path returns false and leaves no stale focus request.
      act(() => {
        model.setFilter("README");
        handleRef.current?.focusPath("README.md");
      });
      const readmeRowEl = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-README.md"]');
      expect(document.activeElement).toBe(readmeRowEl);
      act(() => {
        expect(handleRef.current?.focusPath("dir/child.ts")).toBe(false);
      });
      expect(model.getSnapshot().focusedPath).toBe("README.md");
      act(() => {
        model.setFilter("");
      });
      expect(document.activeElement).toBe(readmeRowEl);

      // 3. startCreate while filtered clears filter so draft input is rendered and delegated error hits onError.
      act(() => {
        model.setFilter("README");
      });
      act(() => {
        handleRef.current?.startCreate("dir", "file");
      });
      expect(model.getSnapshot().filter).toBe("");
      const createInput = host.querySelector<HTMLInputElement>('[data-testid="wb-tree-inline-input"]');
      expect(createInput).not.toBeNull();
      await act(async () => {
        if (createInput) {
          createInput.value = "new.ts";
          createInput.dispatchEvent(new Event("input", { bubbles: true }));
          createInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        }
        await Promise.resolve();
      });
      expect(onCreate).toHaveBeenCalledWith("dir", "file", "new.ts");
      expect(onError).toHaveBeenCalledWith("Unable to create new.ts", expect.any(Error));

      // 4. Full double-click sequence (click 1, click 2, dblclick) on compact segment `a` inside `a / b` renames `a`, not `a/b`.
      // Clicking the terminal segment `a/b` toggles expansion, while clicking ancestor `a` only selects `a`.
      expect(readmeRowEl?.getAttribute("aria-label")).toBe("README.md");

      const segB = host.querySelector<HTMLButtonElement>('[data-testid="wb-tree-segment-a/b"]');
      expect(segB).not.toBeNull();
      const wasExpanded = model.getSnapshot().expanded.has("a/b");
      act(() => {
        segB?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      });
      expect(model.getSnapshot().expanded.has("a/b")).toBe(!wasExpanded);
      act(() => {
        segB?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      });
      expect(model.getSnapshot().expanded.has("a/b")).toBe(wasExpanded);

      const segA = host.querySelector<HTMLButtonElement>('[data-testid="wb-tree-segment-a"]');
      expect(segA).not.toBeNull();
      act(() => {
        segA?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      });
      act(() => {
        segA?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      });
      expect(host.querySelector('[data-testid="wb-tree-segment-a"]')).not.toBeNull();
      act(() => {
        segA?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));
      });
      expect(model.getSnapshot().draft).toEqual({ mode: "rename", path: "a" });
      act(() => {
        model.setDraft(undefined);
      });

      // 5. Touch long-press respects canDrag (README.md is disallowed).
      const readmeRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-README.md"]');
      act(() => {
        readmeRow?.dispatchEvent(
          new PointerEvent("pointerdown", {
            pointerId: 9,
            pointerType: "touch",
            clientX: 10,
            clientY: 10,
            bubbles: true,
          }),
        );
      });
      act(() => {
        vi.advanceTimersByTime(450);
      });
      const scroller = host.querySelector<HTMLElement>("[data-wb-tree-scroller]");
      expect(scroller?.getAttribute("data-touch-dragging")).toBeNull();
      expect(canDrag).toHaveBeenCalledWith(["README.md"]);

      // 6. Canceled external drag clears drop highlight on dragleave, while internal drag retains sources across leave/re-enter.
      const dirRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-dir"]');
      const dragOverEvent = new Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(dragOverEvent, "dataTransfer", {
        value: { types: ["Files"], dropEffect: "none" },
      });
      act(() => {
        dirRow?.dispatchEvent(dragOverEvent);
      });
      expect(dirRow?.getAttribute("data-drop-target")).toBe("true");
      const dragLeaveEvent = new Event("dragleave", { bubbles: true });
      Object.defineProperty(dragLeaveEvent, "relatedTarget", { value: document.body });
      act(() => {
        scroller?.dispatchEvent(dragLeaveEvent);
      });
      expect(dirRow?.getAttribute("data-drop-target")).toBeNull();

      // Internal drag of dir/child.ts leaves scroller, re-enters over `a`, and still executes move.
      const childRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-dir/child.ts"]');
      const aRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-a/b"]');
      const dt = { effectAllowed: "", dropEffect: "", types: [] as string[], setData: vi.fn() };
      const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
      Object.defineProperty(dragStart, "dataTransfer", { value: dt });
      act(() => {
        childRow?.dispatchEvent(dragStart);
      });
      const internalLeave = new Event("dragleave", { bubbles: true });
      Object.defineProperty(internalLeave, "relatedTarget", { value: document.body });
      act(() => {
        scroller?.dispatchEvent(internalLeave);
      });
      const internalReenter = new Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(internalReenter, "dataTransfer", { value: dt });
      act(() => {
        aRow?.dispatchEvent(internalReenter);
      });
      expect(aRow?.getAttribute("data-drop-target")).toBe("true");
      const internalDrop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(internalDrop, "dataTransfer", { value: dt });
      await act(async () => {
        aRow?.dispatchEvent(internalDrop);
        await Promise.resolve();
      });
      expect(onMove).toHaveBeenCalledWith([{ from: "dir/child.ts", to: "a/b/child.ts" }]);
      expect(onError).toHaveBeenCalledWith("Unable to move selected items", expect.any(Error));
    } finally {
      vi.useRealTimers();
    }
  });
});
