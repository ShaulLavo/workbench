import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  DirectoryLoadState,
  FileSystemAdapter,
  FileTreeGitState,
  Subscribable,
} from "@shaulavo/workbench-core";
import { WorkbenchPortalProvider } from "@shaulavo/workbench-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTreeModel } from "../index";
import { FileTreeView } from "../react";

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
    } finally {
      vi.useRealTimers();
    }
  });
});
