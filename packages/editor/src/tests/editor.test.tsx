import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  ActivationFocusDecision,
  EditorGroupsSnapshot,
  EditorTabDescriptor,
  LspHostAdapter,
  LspServerStatus,
  Subscribable,
} from "@shaulavo/workbench-core";
import { WorkbenchPortalProvider } from "@shaulavo/workbench-ui";
import { createStringTextSnapshot } from "@singapore-editor/core/document";
import type { EditorInlineReplacementProvider, EditorViewSnapshot } from "@singapore-editor/core/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkbenchEditorTheme,
  capOverscrollTop,
  createWorkbenchEditorPlugins,
  DEFAULT_MAX_ANALYSIS_BYTES,
  documentFeatureTier,
  EditorTabBar,
  languageIdForPath,
} from "../index";
import { applyTabPlacement, computeEdgeDropZone, listGroupNodes } from "../groups/index";
import { DiagnosticPeek, diagnosticPeekPlacement, LspStatusBadge } from "../lsp/index";
import {
  createMentionInlineReplacementPlugin,
  findMentionRanges,
  findTriggerAtCursor,
  formatMentionToken,
} from "../composer/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let activeRoot: Root | null = null;
let activeHost: HTMLDivElement | null = null;

function mount(element: React.ReactElement): HTMLDivElement {
  activeHost = document.createElement("div");
  document.body.appendChild(activeHost);
  activeRoot = createRoot(activeHost);
  act(() => {
    activeRoot?.render(<WorkbenchPortalProvider>{element}</WorkbenchPortalProvider>);
  });
  return activeHost;
}

afterEach(() => {
  act(() => {
    activeRoot?.unmount();
  });
  activeRoot = null;
  activeHost?.remove();
  activeHost = null;
});

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

describe("@shaulavo/workbench-editor", () => {
  it("resolves language IDs, large-file tiers, overscroll clamping, and responsive plugins", () => {
    expect(languageIdForPath("src/App.tsx")).toBe("tsx");
    expect(languageIdForPath("Dockerfile")).toBe("dockerfile");
    expect(languageIdForPath("README.md")).toBe("markdown");
    expect(languageIdForPath("notes.unknown")).toBeNull();

    const normal = documentFeatureTier(4096);
    expect(normal.analysisAllowed).toBe(true);
    expect(normal.minimapAllowed).toBe(true);

    const large = documentFeatureTier(DEFAULT_MAX_ANALYSIS_BYTES + 1);
    expect(large.analysisAllowed).toBe(false);
    expect(large.minimapAllowed).toBe(false);

    const fakeSnap = {
      totalHeight: 1200,
      viewport: { scrollTop: 950, scrollLeft: 0, clientHeight: 400 },
    } as unknown as EditorViewSnapshot;
    expect(capOverscrollTop(1100, fakeSnap)).toBe(800);
    expect(capOverscrollTop(300, fakeSnap)).toBe(300);

    const fullPlugins = createWorkbenchEditorPlugins({ analysisAllowed: true, narrowViewport: false });
    const degradedPlugins = createWorkbenchEditorPlugins({ analysisAllowed: false, narrowViewport: true });
    expect(fullPlugins.length).toBeGreaterThan(degradedPlugins.length);

    const theme = buildWorkbenchEditorTheme(null);
    expect(theme.syntax?.keyword).toBe("var(--wb-syn-keyword)");
  });

  it("enforces per-activation touch focus policy in EditorTabBar and dismisses focused inputs on touch", () => {
    const tabs: readonly EditorTabDescriptor[] = [
      {
        id: "t1",
        documentId: "src/App.tsx",
        kind: "file",
        path: "src/App.tsx",
        label: "App.tsx",
        title: "src/App.tsx",
      },
      {
        id: "t2",
        documentId: "src/index.ts",
        kind: "file",
        path: "src/index.ts",
        label: "index.ts",
        title: "src/index.ts",
        preview: true,
      },
    ];
    const selected: {
      readonly groupId: string;
      readonly tabId: string;
      readonly focus: ActivationFocusDecision;
    }[] = [];
    const onClose = vi.fn();
    const onPin = vi.fn();

    const host = mount(
      <div>
        <textarea data-testid="prior-input" />
        <EditorTabBar
          groupId="main"
          tabs={tabs}
          selectedTabId="t1"
          onSelectTab={(groupId, tabId, focus) => selected.push({ groupId, tabId, focus })}
          onCloseTab={onClose}
          onPinTab={onPin}
        />
      </div>,
    );

    const priorInput = host.querySelector<HTMLTextAreaElement>('[data-testid="prior-input"]');
    const tab2Btn = host.querySelector<HTMLButtonElement>(
      '[data-testid="wb-editor-tab-t2"] button[role="tab"]',
    );
    expect(tab2Btn).not.toBeNull();

    // Simulate desktop mouse click -> shouldFocusEditor: true.
    act(() => {
      tab2Btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(selected.at(-1)?.focus.shouldFocusEditor).toBe(true);

    // Double-click preview tab -> pins tab.
    act(() => {
      tab2Btn?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(onPin).toHaveBeenCalledWith("main", "t2");

    // Middle-click tab -> closes tab.
    const tab2Wrap = host.querySelector<HTMLDivElement>('[data-testid="wb-editor-tab-t2"]');
    act(() => {
      tab2Wrap?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 1 }));
    });
    expect(onClose).toHaveBeenCalledWith("main", "t2");

    // Touch modality blurs prior input and resolves shouldFocusEditor: false.
    const origMatchMedia = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes("pointer: coarse"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      priorInput?.focus();
      expect(document.activeElement).toBe(priorInput);
      act(() => {
        tab2Btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      });
      expect(selected.at(-1)?.focus.shouldFocusEditor).toBe(false);
      expect(document.activeElement).not.toBe(priorInput);
    } finally {
      window.matchMedia = origMatchMedia;
    }
  });

  it("handles group reorder, cross-group move/copy, edge split, and empty group collapse", () => {
    const t1: EditorTabDescriptor = {
      id: "t1",
      documentId: "a.ts",
      kind: "file",
      label: "a.ts",
      title: "a.ts",
    };
    const t2: EditorTabDescriptor = {
      id: "t2",
      documentId: "b.ts",
      kind: "file",
      label: "b.ts",
      title: "b.ts",
    };
    const initial: EditorGroupsSnapshot = {
      activeGroupId: "g1",
      root: { kind: "group", id: "g1", tabs: [t1, t2], selectedTabId: "t1" },
    };

    // Split t2 onto right edge -> creates horizontal split with 2 groups.
    const split = applyTabPlacement(
      initial,
      { tabId: "t2", mode: "move", target: { kind: "edge", groupId: "g1", edge: "right" } },
      { createGroupId: () => "g2", createSplitId: () => "s1" },
    );
    expect(split.root.kind).toBe("split");
    expect(listGroupNodes(split.root)).toHaveLength(2);
    expect(split.activeGroupId).toBe("g2");

    // Copy t1 from g1 into g2 -> both groups keep their tabs.
    const copied = applyTabPlacement(
      split,
      { tabId: "t1", mode: "copy", target: { kind: "group", groupId: "g2" } },
      { createCopyTabId: () => "t1-copy" },
    );
    const groupsAfterCopy = listGroupNodes(copied.root);
    expect(groupsAfterCopy[0]?.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(groupsAfterCopy[1]?.tabs.map((t) => t.id)).toEqual(["t2", "t1-copy"]);

    // Moving the last tab out of g1 collapses the split back to a single leaf group.
    const collapsed = applyTabPlacement(copied, {
      tabId: "t1",
      mode: "move",
      target: { kind: "strip", groupId: "g2", beforeTabId: "t2" },
    });
    expect(collapsed.root.kind).toBe("group");
    if (collapsed.root.kind === "group") {
      expect(collapsed.root.id).toBe("g2");
      expect(collapsed.root.tabs.map((t) => t.id)).toEqual(["t1", "t2", "t1-copy"]);
    }

    const rect = { left: 0, top: 0, width: 400, height: 300 };
    expect(computeEdgeDropZone({ x: 20, y: 150 }, rect)).toBe("left");
    expect(computeEdgeDropZone({ x: 380, y: 150 }, rect)).toBe("right");
    expect(computeEdgeDropZone({ x: 200, y: 150 }, rect)).toBe("center");
  });

  it("positions DiagnosticPeek, closes on Escape, navigates related targets, and renders LspStatusBadge", () => {
    const placedBelow = diagnosticPeekPlacement({
      anchorRect: { top: 50, bottom: 70, left: 40, right: 120, width: 80, height: 20 },
      clipRect: { top: 0, bottom: 400, left: 0, right: 500, width: 500, height: 400 },
      layerRect: { top: 0, bottom: 400, left: 0, right: 500, width: 500, height: 400 },
      surfaceHeight: 120,
      surfaceWidth: 360,
    });
    expect(placedBelow).toEqual({ left: 40, top: 76 });

    const placedAbove = diagnosticPeekPlacement({
      anchorRect: { top: 340, bottom: 360, left: 400, right: 480, width: 80, height: 20 },
      clipRect: { top: 0, bottom: 400, left: 0, right: 500, width: 500, height: 400 },
      layerRect: { top: 0, bottom: 400, left: 0, right: 500, width: 500, height: 400 },
      surfaceHeight: 120,
      surfaceWidth: 360,
    });
    expect(placedAbove).toEqual({ left: 140, top: 214 });

    const onClose = vi.fn();
    const onOpenTarget = vi.fn();
    const lspStatus = createSubscribable<LspServerStatus>({
      state: "ready",
      label: "TypeScript",
      errorCount: 2,
      warningCount: 1,
    });
    const lspAdapter: LspHostAdapter = {
      status: lspStatus,
      pathToUri: (p) => `file:///${p}`,
      uriToPath: (u) => u.replace(/^file:\/\/\//, ""),
      openLocation: () => true,
    };

    const host = mount(
      <div>
        <LspStatusBadge adapter={lspAdapter} />
        <DiagnosticPeek
          model={{
            severity: "error",
            message: "Type string is not assignable to number",
            source: "ts",
            code: "2322",
            geometry: {
              kind: "visible",
              anchorRect: { top: 40, bottom: 60, left: 20, right: 80, width: 60, height: 20 },
              clipRect: { top: 0, bottom: 400, left: 0, right: 500, width: 500, height: 400 },
            },
            relatedInformation: [
              { label: "Declared here", target: { path: "src/types.ts", line: 9, column: 3 } },
            ],
          }}
          onClose={onClose}
          onOpenTarget={onOpenTarget}
        />
      </div>,
    );

    expect(host.querySelector('[data-testid="wb-lsp-status"]')?.textContent).toContain("2E · 1W");
    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="wb-diagnostic-related-0"]')?.click();
    });
    expect(onClose).toHaveBeenCalledWith(false);
    expect(onOpenTarget).toHaveBeenCalledWith({ path: "src/types.ts", line: 9, column: 3 });

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it("parses @file mentions and /slash triggers while producing atomic reveal:never Singapore chips", () => {
    expect(formatMentionToken("src/App.tsx")).toBe("@src/App.tsx");
    expect(formatMentionToken("docs/my guide.md")).toBe("@[docs/my guide.md]");

    const mentions = findMentionRanges("Check @src/App.tsx and @[docs/my guide.md], ignore user@example.com");
    expect(mentions).toHaveLength(2);
    expect(mentions[0]).toMatchObject({ path: "src/App.tsx", label: "@App.tsx" });
    expect(mentions[1]).toMatchObject({ path: "docs/my guide.md", label: "@my guide.md" });

    expect(findTriggerAtCursor("Inspect @app", 12)).toEqual({
      kind: "mention",
      start: 8,
      end: 12,
      query: "app",
    });
    expect(findTriggerAtCursor("/fix", 4)).toEqual({
      kind: "slash",
      start: 0,
      end: 4,
      query: "fix",
    });
    expect(findTriggerAtCursor("hello ", 6)).toBeNull();

    // Verify Singapore inline replacement provider registers with trigger:"edit" and atomic reveal:"never".
    const providerHolder: {
      current: EditorInlineReplacementProvider | null;
      trigger?: string;
    } = { current: null };
    const plugin = createMentionInlineReplacementPlugin();
    plugin.activate({
      registerInlineReplacementProvider(
        provider: EditorInlineReplacementProvider,
        options?: { readonly trigger?: string },
      ) {
        providerHolder.current = provider;
        providerHolder.trigger = options?.trigger;
        return { dispose: () => {} };
      },
    } as unknown as Parameters<typeof plugin.activate>[0]);

    expect(providerHolder.trigger).toBe("edit");
    const specs = providerHolder.current!({
      textSnapshot: createStringTextSnapshot("Refactor @src/App.tsx now"),
      languageId: "markdown",
      captures: [],
      selections: [],
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      startIndex: 9,
      endIndex: 21,
      text: "@App.tsx",
      reveal: "never",
      atomic: true,
    });
  });
});
