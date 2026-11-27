import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  DirectoryLoadState,
  FileSystemAdapter,
  FileTreeGitState,
  LazyInvalidationEvent,
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

      // 7. F2 rename while filtered clears the filter and expands collapsed ancestors before opening input.
      act(() => {
        model.setExpanded("dir", false);
        model.setFilter("child");
        model.select("dir/child.ts", "replace", "keyboard");
      });
      const filteredChildRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-dir/child.ts"]');
      expect(filteredChildRow).not.toBeNull();
      act(() => {
        filteredChildRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
      });
      expect(model.getSnapshot().filter).toBe("");
      expect(model.getSnapshot().expanded.has("dir")).toBe(true);
      expect(model.getSnapshot().draft).toEqual({ mode: "rename", path: "dir/child.ts" });
      expect(host.querySelector('[data-testid="wb-tree-inline-input"]')).not.toBeNull();
      act(() => {
        model.setDraft(undefined);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores row focus when built-in context menu closes with Escape while keeping Rename input focused", async () => {
    const model = new FileTreeModel({ paths: ["CLAUDE.md", "src/index.ts"], initialExpanded: ["src"] });
    const host = mount(
      <WorkbenchPortalProvider>
        <FileTreeView model={model} />
      </WorkbenchPortalProvider>,
    );

    const claudeRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-CLAUDE.md"]');
    expect(claudeRow).not.toBeNull();
    act(() => {
      claudeRow?.focus();
    });
    expect(document.activeElement).toBe(claudeRow);

    await act(async () => {
      claudeRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
      await Promise.resolve();
    });
    const menuPopup = host.querySelector<HTMLElement>("[data-wb-point-context-menu]");
    expect(menuPopup).not.toBeNull();

    // Escape closes the menu and restores focus to the triggering row.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector("[data-wb-point-context-menu]")).toBeNull();
    expect(document.activeElement).toBe(claudeRow);

    // Reopen and choose Rename: focus must stay on the newly mounted inline rename input.
    await act(async () => {
      claudeRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }));
      await Promise.resolve();
    });
    const renameItem = host.querySelector<HTMLElement>('[data-testid="wb-tree-ctx-rename"]');
    expect(renameItem).not.toBeNull();
    act(() => {
      renameItem?.click();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(model.getSnapshot().draft).toEqual({ mode: "rename", path: "CLAUDE.md" });
    const inlineInput = host.querySelector<HTMLInputElement>('[data-testid="wb-tree-inline-input"]');
    expect(inlineInput).not.toBeNull();
    expect(document.activeElement).toBe(inlineInput);
  });

  it("falls back to focused row on keyboard Delete, honors externalCommands, and sets data-guide-level", async () => {
    const onRequestDelete = vi.fn();
    const model = new FileTreeModel({
      paths: ["src/a.ts", "a/b/c.ts", "README.md"],
      initialExpanded: ["src", "a", "a/b"],
    });
    const host = mount(<FileTreeView model={model} onRequestDelete={onRequestDelete} />);

    // Indent guide carries 0-based depth level for consumer syntax-color styling.
    const guide = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-src/a.ts"] .wb-tree-guide');
    expect(guide?.getAttribute("data-guide-level")).toBe("0");

    // Focused row with empty selection still triggers onRequestDelete on Delete key.
    const readmeRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-README.md"]');
    act(() => {
      readmeRow?.focus();
    });
    expect(model.getSelectedPaths()).toEqual([]);
    act(() => {
      readmeRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(onRequestDelete).toHaveBeenCalledWith(["README.md"]);

    // Focused intermediate compact segment `a` inside `a/b` deletes `a`, not `a/b`.
    onRequestDelete.mockClear();
    const compactRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-a/b"]');
    act(() => {
      model.setFocusedPath("a", "keyboard");
    });
    act(() => {
      compactRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(onRequestDelete).toHaveBeenCalledWith(["a"]);

    // externalCommands suppresses built-in F2/Mod+A/Space/Delete shortcuts so consumer keymaps own them.
    onRequestDelete.mockClear();
    const extModel = new FileTreeModel({ paths: ["README.md", "notes.md"] });
    const extHost = mount(
      <FileTreeView
        model={extModel}
        onRequestDelete={onRequestDelete}
        externalCommands={new Set(["rename", "selectAll", "toggleMark", "delete"])}
      />,
    );
    const extRow = extHost.querySelector<HTMLElement>('[data-testid="wb-tree-row-README.md"]');
    act(() => {
      extRow?.focus();
    });
    act(() => {
      extRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
      extRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
      extRow?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      extRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(extModel.getSnapshot().draft).toBeUndefined();
    expect(extModel.getSelectedPaths()).toEqual([]);
    expect(onRequestDelete).not.toHaveBeenCalled();

    // Adapterless delete reconciles selection/focus on completion so a subsequent Delete targets the surviving row.
    const delModel = new FileTreeModel({ paths: ["gone.ts", "keep.ts"] });
    const delHost = mount(<FileTreeView model={delModel} />);
    const goneRow = delHost.querySelector<HTMLElement>('[data-testid="wb-tree-row-gone.ts"]');
    act(() => {
      goneRow?.click();
    });
    expect(delModel.getSelectedPaths()).toEqual(["gone.ts"]);
    act(() => {
      goneRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    const confirmBtn = delHost.querySelector<HTMLButtonElement>('[data-testid="wb-confirm-accept"]');
    expect(confirmBtn).not.toBeNull();
    await act(async () => {
      confirmBtn?.click();
      await Promise.resolve();
    });
    expect(delModel.index.hasPath("gone.ts")).toBe(false);
    expect(delModel.getSelectedPaths()).toEqual([]);
    expect(delModel.getSnapshot().focusedPath).toBeUndefined();

    // Partial batch delete rollback during a lazy reset prunes only the deleted path and keeps the surviving row's focus/selection.
    const rootState = createSubscribable<DirectoryLoadState>({
      status: "loaded",
      entries: [
        { name: "first.ts", kind: "file" },
        { name: "second.ts", kind: "file" },
      ],
    });
    const invListeners = new Set<(event: LazyInvalidationEvent) => void>();
    const onPartialError = vi.fn();
    const partialAdapter: FileSystemAdapter = {
      workspaceId: "test-partial-reset",
      writable: createSubscribable(true),
      lazy: {
        getDirectoryState: () => rootState,
        loadDirectory: async () => {},
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
      async remove(path) {
        if (path === "first.ts") {
          for (const listener of invListeners) {
            listener({ reset: true, directories: [], moves: [], removed: [] });
          }
          return;
        }
        throw new Error("second delete failed");
      },
    };
    const partialModel = new FileTreeModel();
    const partialHost = mount(
      <FileTreeView model={partialModel} adapter={partialAdapter} onError={onPartialError} />,
    );
    act(() => {
      partialModel.setSelectedPaths(["first.ts", "second.ts"], {
        focusedPath: "second.ts",
        modality: "keyboard",
      });
    });
    const secondRow = partialHost.querySelector<HTMLElement>('[data-testid="wb-tree-row-second.ts"]');
    act(() => {
      secondRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    const partialConfirm = partialHost.querySelector<HTMLButtonElement>('[data-testid="wb-confirm-accept"]');
    await act(async () => {
      partialConfirm?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(onPartialError).toHaveBeenCalledTimes(1);
    expect(partialModel.getSelectedPaths()).toEqual(["second.ts"]);
    expect(partialModel.getSnapshot().focusedPath).toBe("second.ts");

    // Drag move rebases selection/focus to destination path, and filtered Delete targets only visible selected rows.
    const moveModel = new FileTreeModel({
      paths: ["renamed/a.txt", "other/keep.txt", "alpha.txt", "beta.txt"],
      initialExpanded: ["renamed", "other"],
    });
    const onFilteredDelete = vi.fn();
    const moveHost = mount(<FileTreeView model={moveModel} onRequestDelete={onFilteredDelete} />);
    const renamedRow = moveHost.querySelector<HTMLElement>('[data-testid="wb-tree-row-renamed"]');
    const otherRow = moveHost.querySelector<HTMLElement>('[data-testid="wb-tree-row-other"]');
    act(() => {
      renamedRow?.click();
    });
    const dt = { effectAllowed: "", dropEffect: "", types: [] as string[], setData: vi.fn() };
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dt });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dt });
    act(() => {
      renamedRow?.dispatchEvent(dragStart);
      otherRow?.dispatchEvent(drop);
    });
    expect(moveModel.getSelectedPaths()).toEqual(["other/renamed"]);
    expect(moveModel.getSnapshot().focusedPath).toBe("other/renamed");

    // Filter hides beta.txt while alpha.txt and beta.txt are selected: Delete targets only visible alpha.txt.
    act(() => {
      moveModel.setSelectedPaths(["alpha.txt", "beta.txt"], {
        focusedPath: "alpha.txt",
        modality: "keyboard",
      });
      moveModel.setFilter("alpha");
    });
    const alphaRow = moveHost.querySelector<HTMLElement>('[data-testid="wb-tree-row-alpha.txt"]');
    act(() => {
      alphaRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(onFilteredDelete).toHaveBeenCalledWith(["alpha.txt"]);

    // When filter hides every selected path, Delete does not fall back to an unrelated focused row.
    onFilteredDelete.mockClear();
    act(() => {
      moveModel.setSelectedPaths(["beta.txt"], { focusedPath: "alpha.txt", modality: "keyboard" });
    });
    act(() => {
      alphaRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(onFilteredDelete).not.toHaveBeenCalled();
  });

  it("preflights multi-select move collisions before moving any item and restores initialScrollTop after lazy rows load", async () => {
    const moveCalls: { from: string; to: string }[] = [];
    const onMoveError = vi.fn();
    const collisionModel = new FileTreeModel({
      paths: ["a.txt", "b.txt", "dest/b.txt"],
      initialExpanded: ["dest"],
    });
    const collisionAdapter: FileSystemAdapter = {
      workspaceId: "move-preflight",
      writable: { getSnapshot: () => true, subscribe: () => () => {} },
      listFiles: async () => ["a.txt", "b.txt", "dest/b.txt"],
      readText: async () => undefined,
      size: async () => undefined,
      createFile: async () => {},
      createDirectory: async () => {},
      move: async (from, to) => {
        moveCalls.push({ from, to });
      },
      remove: async () => {},
    };
    const host = mount(
      <FileTreeView model={collisionModel} adapter={collisionAdapter} onError={onMoveError} />,
    );
    act(() => {
      collisionModel.setSelectedPaths(["a.txt", "b.txt"], {
        focusedPath: "a.txt",
        modality: "pointer",
      });
    });
    const aRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-a.txt"]');
    const destRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-dest"]');
    const dt = { effectAllowed: "", dropEffect: "", types: [] as string[], setData: vi.fn() };
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", { value: dt });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: dt });
    await act(async () => {
      aRow?.dispatchEvent(dragStart);
      destRow?.dispatchEvent(drop);
      await Promise.resolve();
    });
    expect(moveCalls).toEqual([]);
    expect(onMoveError).toHaveBeenCalledTimes(1);
    expect(collisionModel.index.hasPath("a.txt")).toBe(true);
    expect(collisionModel.index.hasPath("dest/a.txt")).toBe(false);

    // Deferred initialScrollTop restoration waits until lazy rows arrive.
    const lazyScrollModel = new FileTreeModel();
    const onScrollTopChange = vi.fn();
    const scrollHost = mount(
      <FileTreeView
        model={lazyScrollModel}
        rowHeight={26}
        initialScrollTop={800}
        onScrollTopChange={onScrollTopChange}
      />,
    );
    const scroller = scrollHost.querySelector<HTMLDivElement>("[data-wb-tree-scroller]")!;
    expect(scroller.scrollTop).toBe(0);

    const manyFiles = Array.from({ length: 100 }, (_, i) => ({
      name: `file-${String(i).padStart(3, "0")}.txt`,
      kind: "file" as const,
    }));
    act(() => {
      lazyScrollModel.index.setLazyDirectoryState("", { status: "loaded", entries: manyFiles });
      lazyScrollModel.notifyIndexChange();
    });
    expect(scroller.scrollTop).toBe(800);

    // Dropping a.txt and b.txt onto an unopened lazy folder containing b.txt awaits its listing and aborts before moving a.txt.
    const lazyMoveCalls: { from: string; to: string }[] = [];
    const onLazyMoveError = vi.fn();
    const lazySlots = new Map<string, { state: DirectoryLoadState; listeners: Set<() => void> }>();
    const getLazySlot = (dir: string) => {
      let slot = lazySlots.get(dir);
      if (!slot) {
        slot = { state: { status: "idle" }, listeners: new Set() };
        lazySlots.set(dir, slot);
      }
      return slot;
    };
    const setLazySlot = (dir: string, next: DirectoryLoadState) => {
      const slot = getLazySlot(dir);
      slot.state = next;
      for (const listener of slot.listeners) listener();
    };
    const lazyMoveAdapter: FileSystemAdapter = {
      workspaceId: "lazy-move-preflight",
      writable: { getSnapshot: () => true, subscribe: () => () => {} },
      listFiles: async () => ["a.txt", "b.txt", "unopened/b.txt"],
      readText: async () => undefined,
      size: async () => undefined,
      createFile: async () => {},
      createDirectory: async () => {},
      move: async (from, to) => {
        lazyMoveCalls.push({ from, to });
      },
      remove: async () => {},
      lazy: {
        getDirectoryState(dirPath) {
          const slot = getLazySlot(dirPath);
          return {
            getSnapshot: () => slot.state,
            subscribe(listener) {
              slot.listeners.add(listener);
              return () => slot.listeners.delete(listener);
            },
          };
        },
        async loadDirectory(dirPath) {
          if (dirPath === "") {
            setLazySlot("", {
              status: "loaded",
              entries: [
                { name: "unopened", kind: "directory" },
                { name: "a.txt", kind: "file" },
                { name: "b.txt", kind: "file" },
              ],
            });
            return;
          }
          if (dirPath === "unopened") {
            setLazySlot("unopened", {
              status: "loaded",
              entries: [{ name: "b.txt", kind: "file" }],
            });
          }
        },
        subscribeInvalidation: () => () => {},
      },
    };
    const lazyMoveModel = new FileTreeModel();
    const lazyMoveHost = mount(
      <FileTreeView model={lazyMoveModel} adapter={lazyMoveAdapter} onError={onLazyMoveError} />,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => {
      lazyMoveModel.setSelectedPaths(["a.txt", "b.txt"], {
        focusedPath: "a.txt",
        modality: "pointer",
      });
    });
    const lazyARow = lazyMoveHost.querySelector<HTMLElement>('[data-testid="wb-tree-row-a.txt"]');
    const unopenedRow = lazyMoveHost.querySelector<HTMLElement>('[data-testid="wb-tree-row-unopened"]');
    const lazyStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(lazyStart, "dataTransfer", { value: dt });
    const lazyDrop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(lazyDrop, "dataTransfer", { value: dt });
    await act(async () => {
      lazyARow?.dispatchEvent(lazyStart);
      unopenedRow?.dispatchEvent(lazyDrop);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(lazyMoveCalls).toEqual([]);
    expect(onLazyMoveError).toHaveBeenCalledTimes(1);
    expect(lazyMoveModel.index.hasPath("a.txt")).toBe(true);
    expect(lazyMoveModel.index.hasPath("unopened/a.txt")).toBe(false);

    // Clamped initialScrollTop finalizes once initial lazy load settles and does not jump on later expansion.
    const clampedScrollChanges: number[] = [];
    const clampedSlots = new Map<string, { state: DirectoryLoadState; listeners: Set<() => void> }>();
    const getClampedSlot = (dir: string) => {
      let slot = clampedSlots.get(dir);
      if (!slot) {
        slot = { state: { status: "idle" }, listeners: new Set() };
        clampedSlots.set(dir, slot);
      }
      return slot;
    };
    let resolveClampedRoot!: () => void;
    const clampedRootReady = new Promise<void>((resolve) => {
      resolveClampedRoot = resolve;
    });
    const clampedAdapter: FileSystemAdapter = {
      workspaceId: "clamped-scroll",
      writable: { getSnapshot: () => true, subscribe: () => () => {} },
      listFiles: async () => [],
      readText: async () => undefined,
      size: async () => undefined,
      createFile: async () => {},
      createDirectory: async () => {},
      move: async () => {},
      remove: async () => {},
      lazy: {
        getDirectoryState(dirPath) {
          const slot = getClampedSlot(dirPath);
          return {
            getSnapshot: () => slot.state,
            subscribe(listener) {
              slot.listeners.add(listener);
              return () => slot.listeners.delete(listener);
            },
          };
        },
        async loadDirectory(dirPath) {
          const slot = getClampedSlot(dirPath);
          if (dirPath === "") {
            slot.state = { status: "loading" };
            for (const listener of slot.listeners) listener();
            await clampedRootReady;
            slot.state = {
              status: "loaded",
              entries: [
                { name: "big", kind: "directory" },
                { name: "small.txt", kind: "file" },
              ],
            };
          } else if (dirPath === "big") {
            slot.state = { status: "loaded", entries: manyFiles };
          }
          for (const listener of slot.listeners) listener();
        },
        subscribeInvalidation: () => () => {},
      },
    };
    const clampedModel = new FileTreeModel();
    const clampedHost = mount(
      <FileTreeView
        model={clampedModel}
        adapter={clampedAdapter}
        rowHeight={26}
        initialScrollTop={800}
        onScrollTopChange={(top) => clampedScrollChanges.push(top)}
      />,
    );
    const clampedScroller = clampedHost.querySelector<HTMLDivElement>("[data-wb-tree-scroller]")!;
    let clampedTop = 0;
    Object.defineProperty(clampedScroller, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(clampedScroller, "scrollHeight", {
      get: () => clampedModel.getSnapshot().rows.length * 26,
      configurable: true,
    });
    Object.defineProperty(clampedScroller, "scrollTop", {
      get: () => clampedTop,
      set: (value: number) => {
        const max = Math.max(0, clampedModel.getSnapshot().rows.length * 26 - 400);
        clampedTop = Math.max(0, Math.min(value, max));
      },
      configurable: true,
    });
    expect(clampedScrollChanges).toEqual([]);
    await act(async () => {
      resolveClampedRoot();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clampedScroller.scrollTop).toBe(0);
    expect(clampedScrollChanges).toEqual([0]);

    // Later folder expansion must NOT jump scrollTop back to 800.
    await act(async () => {
      clampedModel.setExpanded("big", true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clampedScroller.scrollTop).toBe(0);

    // Collapsed ancestor "outer" with saved nested "outer/inner" must not keep initial scroll pending.
    const nestedScrollChanges: number[] = [];
    const nestedSlots = new Map<string, { state: DirectoryLoadState; listeners: Set<() => void> }>();
    const getNestedSlot = (dir: string) => {
      let slot = nestedSlots.get(dir);
      if (!slot) {
        slot = { state: { status: "idle" }, listeners: new Set() };
        nestedSlots.set(dir, slot);
      }
      return slot;
    };
    let resolveNestedRoot!: () => void;
    const nestedRootReady = new Promise<void>((resolve) => {
      resolveNestedRoot = resolve;
    });
    const nestedAdapter: FileSystemAdapter = {
      workspaceId: "nested-scroll",
      writable: { getSnapshot: () => true, subscribe: () => () => {} },
      listFiles: async () => [],
      readText: async () => undefined,
      size: async () => undefined,
      createFile: async () => {},
      createDirectory: async () => {},
      move: async () => {},
      remove: async () => {},
      lazy: {
        getDirectoryState(dirPath) {
          const slot = getNestedSlot(dirPath);
          return {
            getSnapshot: () => slot.state,
            subscribe(listener) {
              slot.listeners.add(listener);
              return () => slot.listeners.delete(listener);
            },
          };
        },
        async loadDirectory(dirPath) {
          const slot = getNestedSlot(dirPath);
          if (dirPath === "") {
            slot.state = { status: "loading" };
            for (const listener of slot.listeners) listener();
            await nestedRootReady;
            slot.state = {
              status: "loaded",
              entries: [{ name: "outer", kind: "directory" }],
            };
          } else if (dirPath === "outer") {
            slot.state = {
              status: "loaded",
              entries: [{ name: "inner", kind: "directory" }],
            };
          } else if (dirPath === "outer/inner") {
            slot.state = { status: "loaded", entries: manyFiles };
          }
          for (const listener of slot.listeners) listener();
        },
        subscribeInvalidation: () => () => {},
      },
    };
    const nestedModel = new FileTreeModel({ initialExpanded: ["outer/inner"] });
    const nestedHost = mount(
      <FileTreeView
        model={nestedModel}
        adapter={nestedAdapter}
        rowHeight={26}
        initialScrollTop={800}
        onScrollTopChange={(top) => nestedScrollChanges.push(top)}
      />,
    );
    const nestedScroller = nestedHost.querySelector<HTMLDivElement>("[data-wb-tree-scroller]")!;
    let nestedTop = 0;
    Object.defineProperty(nestedScroller, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(nestedScroller, "scrollHeight", {
      get: () => nestedModel.getSnapshot().rows.length * 26,
      configurable: true,
    });
    Object.defineProperty(nestedScroller, "scrollTop", {
      get: () => nestedTop,
      set: (value: number) => {
        const max = Math.max(0, nestedModel.getSnapshot().rows.length * 26 - 400);
        nestedTop = Math.max(0, Math.min(value, max));
      },
      configurable: true,
    });
    await act(async () => {
      resolveNestedRoot();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(nestedScrollChanges).toEqual([0]);
    await act(async () => {
      nestedModel.setExpanded("outer", true);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(nestedScroller.scrollTop).toBe(0);
  });

  it("loads unopened lazy ancestors before starting rename on a filtered result", async () => {
    const slots = new Map<string, { state: DirectoryLoadState; listeners: Set<() => void> }>();
    const getSlot = (dir: string) => {
      let slot = slots.get(dir);
      if (!slot) {
        slot = { state: { status: "idle" }, listeners: new Set() };
        slots.set(dir, slot);
      }
      return slot;
    };
    const loadedDirs: string[] = [];
    const adapter: FileSystemAdapter = {
      workspaceId: "ws-lazy-rename",
      writable: { getSnapshot: () => true, subscribe: () => () => {} },
      listFiles: async () => ["closed/sub/needle.txt"],
      readText: async () => "",
      createFile: async () => {},
      createDirectory: async () => {},
      move: async () => {},
      remove: async () => {},
      lazy: {
        getDirectoryState(dirPath) {
          const slot = getSlot(dirPath);
          return {
            getSnapshot: () => slot.state,
            subscribe(listener) {
              slot.listeners.add(listener);
              return () => slot.listeners.delete(listener);
            },
          };
        },
        async loadDirectory(dirPath) {
          loadedDirs.push(dirPath);
          const slot = getSlot(dirPath);
          if (dirPath === "") {
            slot.state = { status: "loaded", entries: [{ name: "closed", kind: "directory" }] };
          } else if (dirPath === "closed") {
            slot.state = { status: "loaded", entries: [{ name: "sub", kind: "directory" }] };
          } else if (dirPath === "closed/sub") {
            slot.state = { status: "loaded", entries: [{ name: "needle.txt", kind: "file" }] };
          }
          for (const listener of slot.listeners) listener();
        },
        subscribeInvalidation: () => () => {},
      },
    };

    const model = new FileTreeModel();
    const handleRef = { current: null as FileTreeViewHandle | null };
    const host = mount(<FileTreeView model={model} adapter={adapter} handleRef={handleRef} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Filter finds closed/sub/needle.txt without opening closed or closed/sub.
    await act(async () => {
      model.setFilter("needle");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(model.index.hasPath("closed/sub/needle.txt")).toBe(false);
    const needleRow = host.querySelector<HTMLElement>('[data-testid="wb-tree-row-closed/sub/needle.txt"]');
    expect(needleRow).not.toBeNull();

    // Pressing F2 loads unopened ancestors, clears filter, expands ancestors, and opens inline rename.
    act(() => {
      model.select("closed/sub/needle.txt", "replace", "keyboard");
    });
    await act(async () => {
      needleRow?.dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadedDirs).toContain("closed");
    expect(loadedDirs).toContain("closed/sub");
    expect(model.getSnapshot().filter).toBe("");
    expect(model.getSnapshot().draft).toEqual({ mode: "rename", path: "closed/sub/needle.txt" });
    expect(host.querySelector('[data-testid="wb-tree-inline-input"]')).not.toBeNull();

    // Also verify handleRef.startRename on the loaded path.
    act(() => {
      model.setDraft(undefined);
    });
    act(() => {
      handleRef.current?.startRename("closed/sub/needle.txt");
    });
    expect(model.getSnapshot().draft).toEqual({ mode: "rename", path: "closed/sub/needle.txt" });
  });
});
