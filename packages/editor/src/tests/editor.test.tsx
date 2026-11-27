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
  clampRestoredScroll,
  createWorkbenchEditorPlugins,
  DEFAULT_MAX_ANALYSIS_BYTES,
  documentFeatureTier,
  EditorTabBar,
  languageIdForPath,
  languageLabelForPath,
} from "../index";
import {
  getDocumentDraft,
  isDraftDirty,
  persistDocumentDraft,
  recordDocumentEdit,
  replaceDocumentDraftFromDisk,
  seedDocumentDraft,
  subscribeDocumentDraft,
} from "../utils/draft-store";
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
    expect(languageIdForPath("src/Page.svelte")).toBe("svelte");
    expect(languageIdForPath("src/App.vue")).toBe("html");
    expect(languageIdForPath("notes.unknown")).toBeNull();
    expect(languageIdForPath("file.__proto__")).toBeNull();
    expect(languageIdForPath("file.constructor")).toBeNull();
    expect(languageLabelForPath("src/App.tsx")).toBe("TypeScript JSX");
    expect(languageLabelForPath("src/App.vue")).toBe("Vue");
    expect(languageLabelForPath("notes.unknown")).toBe("Plain Text");
    expect(languageLabelForPath("file.__proto__")).toBe("Plain Text");
    expect(languageLabelForPath("file.constructor")).toBe("Plain Text");

    expect(clampRestoredScroll({ left: 0, top: 1100 }, 1200, 400)).toEqual({ left: 0, top: 800 });
    expect(clampRestoredScroll({ left: 4, top: 200 }, 1200, 400)).toEqual({ left: 4, top: 200 });

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

    const fullPlugins = createWorkbenchEditorPlugins({
      analysisAllowed: true,
      narrowViewport: false,
      useDefaultHighlighting: true,
    });
    const degradedPlugins = createWorkbenchEditorPlugins({ analysisAllowed: false, narrowViewport: true });
    expect(fullPlugins.length).toBeGreaterThan(degradedPlugins.length);

    const theme = buildWorkbenchEditorTheme(null);
    expect(theme.syntax?.keyword).toBe("var(--wb-syn-keyword)");
  });

  it("disambiguates duplicate tab labels, handles Delete/arrow navigation, and reorders via non-touch pointer drag", () => {
    const tabs: readonly EditorTabDescriptor[] = [
      {
        id: "src/a/index.ts",
        documentId: "src/a/index.ts",
        kind: "file",
        path: "src/a/index.ts",
        label: "index.ts",
        title: "src/a/index.ts",
        tone: "ts",
      },
      {
        id: "src/b/index.ts",
        documentId: "src/b/index.ts",
        kind: "file",
        path: "src/b/index.ts",
        label: "index.ts",
        title: "src/b/index.ts",
        missing: true,
      },
    ];
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const onReorder = vi.fn();
    const host = mount(
      <EditorTabBar
        groupId="main"
        tabs={tabs}
        selectedTabId="src/a/index.ts"
        onSelectTab={onSelect}
        onCloseTab={onClose}
        onReorderTab={onReorder}
      />,
    );

    const hints = Array.from(host.querySelectorAll(".wb-tab-hint"), (el) => el.textContent);
    expect(hints).toEqual(["src/a", "src/b"]);
    const tabEls = Array.from(host.querySelectorAll<HTMLElement>("[data-wb-tab]"));
    expect(tabEls[0]?.getAttribute("data-tab-tone")).toBe("ts");
    expect(tabEls[1]?.getAttribute("data-missing")).toBe("true");

    // ArrowRight moves focus to the next tab; Delete closes it.
    const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
    buttons[0]?.focus();
    act(() => {
      buttons[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(document.activeElement).toBe(buttons[1]);
    act(() => {
      buttons[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledWith("main", "src/b/index.ts");

    // Mouse drag reorders past threshold and suppresses trailing click.
    tabEls[0]!.getBoundingClientRect = () => ({
      left: 0,
      right: 100,
      width: 100,
      top: 0,
      bottom: 32,
      height: 32,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    tabEls[1]!.getBoundingClientRect = () => ({
      left: 100,
      right: 200,
      width: 100,
      top: 0,
      bottom: 32,
      height: 32,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });
    act(() => {
      tabEls[0]?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 1,
          pointerType: "mouse",
          clientX: 50,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { bubbles: true, pointerId: 1, pointerType: "mouse", clientX: 180 }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerId: 1, pointerType: "mouse", clientX: 180 }),
      );
      buttons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(onReorder).toHaveBeenCalledWith("main", 0, 1);
    expect(onSelect).not.toHaveBeenCalled();

    // Touch pointerdown -> click resolves shouldFocusEditor: false even when click lacks pointerType.
    act(() => {
      tabEls[1]?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 2,
          pointerType: "touch",
          clientX: 120,
        }),
      );
      buttons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(onSelect).toHaveBeenCalledWith("main", "src/b/index.ts", {
      shouldFocusEditor: false,
      origin: "touch",
    });

    // Dragging and releasing outside the strip must NOT swallow subsequent keyboard activation (detail === 0).
    onSelect.mockClear();
    onReorder.mockClear();
    act(() => {
      tabEls[0]?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 3,
          pointerType: "mouse",
          clientX: 50,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 3,
          pointerType: "mouse",
          clientX: 180,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 3,
          pointerType: "mouse",
          clientX: 180,
        }),
      );
      // Keyboard Enter emits a synthetic click with detail === 0 without any pointer click on the tab.
      buttons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      "main",
      "src/b/index.ts",
      expect.objectContaining({ shouldFocusEditor: true }),
    );
  });

  it("cancels active tab drag when groupId changes and handles delayed host reorders accurately", () => {
    const tabs: readonly EditorTabDescriptor[] = [
      { id: "a", documentId: "a", kind: "file", path: "a.ts", label: "a.ts", title: "a.ts" },
      { id: "b", documentId: "b", kind: "file", path: "b.ts", label: "b.ts", title: "b.ts" },
      { id: "c", documentId: "c", kind: "file", path: "c.ts", label: "c.ts", title: "c.ts" },
    ];
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const onReorder = vi.fn();

    const host = mount(
      <EditorTabBar
        groupId="g1"
        tabs={tabs}
        selectedTabId="a"
        onSelectTab={onSelect}
        onCloseTab={onClose}
        onReorderTab={onReorder}
      />,
    );

    const mockRects = (container: HTMLElement) => {
      const els = Array.from(container.querySelectorAll<HTMLElement>("[data-wb-tab]"));
      els.forEach((el, idx) => {
        el.getBoundingClientRect = () => ({
          left: idx * 100,
          right: (idx + 1) * 100,
          width: 100,
          top: 0,
          bottom: 32,
          height: 32,
          x: idx * 100,
          y: 0,
          toJSON: () => ({}),
        });
      });
      return els;
    };

    const tabEls = mockRects(host);
    // Start dragging A past C (slot 2) without host updating tabs yet, then drag back between B and C (slot 1).
    act(() => {
      tabEls[0]?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 10,
          pointerType: "mouse",
          clientX: 40,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 10,
          pointerType: "mouse",
          clientX: 280,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 10,
          pointerType: "mouse",
          clientX: 180,
        }),
      );
    });
    expect(onReorder).toHaveBeenNthCalledWith(1, "g1", 0, 2);
    expect(onReorder).toHaveBeenNthCalledWith(2, "g1", 0, 1);

    // Changing groupId while dragging cancels the gesture instead of emitting a reorder for g2.
    onReorder.mockClear();
    act(() => {
      activeRoot?.render(
        <WorkbenchPortalProvider>
          <EditorTabBar
            groupId="g2"
            tabs={tabs}
            selectedTabId="a"
            onSelectTab={onSelect}
            onCloseTab={onClose}
            onReorderTab={onReorder}
          />
        </WorkbenchPortalProvider>,
      );
    });
    mockRects(host);
    act(() => {
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 10,
          pointerType: "mouse",
          clientX: 280,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 10,
          pointerType: "mouse",
          clientX: 280,
        }),
      );
    });
    expect(onReorder).not.toHaveBeenCalled();
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

    // Stale/missing destination groups must be lossless no-ops (never drop source tab or corrupt activeGroupId).
    const missingGroupMove = applyTabPlacement(initial, {
      tabId: "t1",
      mode: "move",
      target: { kind: "group", groupId: "missing-group" },
    });
    expect(missingGroupMove).toBe(initial);

    const missingEdgeMove = applyTabPlacement(initial, {
      tabId: "t1",
      mode: "move",
      target: { kind: "edge", groupId: "missing-group", edge: "right" },
    });
    expect(missingEdgeMove).toBe(initial);

    // Strip self-placement (`beforeTabId === tabId`) must be a no-op rather than appending the tab.
    const selfStrip = applyTabPlacement(initial, {
      tabId: "t1",
      mode: "move",
      target: { kind: "strip", groupId: "g1", beforeTabId: "t1" },
    });
    expect(selfStrip).toBe(initial);

    // 1-tab self-edge split must be a no-op.
    const singleGroup: EditorGroupsSnapshot = {
      activeGroupId: "solo",
      root: { kind: "group", id: "solo", tabs: [t1], selectedTabId: "t1" },
    };
    const selfEdge = applyTabPlacement(singleGroup, {
      tabId: "t1",
      mode: "move",
      target: { kind: "edge", groupId: "solo", edge: "right" },
    });
    expect(selfEdge).toBe(singleGroup);
  });

  it("preserves drafts across switches, serializes overlapping saves, and keeps dirty flag for mid-save edits", async () => {
    let resolveFirstWrite: (() => void) | undefined;
    let notifyFirstWriteStarted: (() => void) | undefined;
    const firstWriteStarted = new Promise<void>((resolve) => {
      notifyFirstWriteStarted = resolve;
    });
    const writes: { readonly docId: string; readonly text: string; readonly expected?: string }[] = [];
    let revA = 1;
    let revB = 10;

    const adapter = {
      getConflict: () => createSubscribable(undefined),
      loadDocument: async () => undefined,
      async writeIfUnchanged(docId: string, text: string, expectedRevision: string | undefined) {
        writes.push({ docId, text, expected: expectedRevision });
        if (writes.length === 1) {
          notifyFirstWriteStarted?.();
          await new Promise<void>((resolve) => {
            resolveFirstWrite = resolve;
          });
        }
        if (docId === "a.ts") {
          revA += 1;
          return { written: true as const, nextRevision: String(revA) };
        }
        revB += 1;
        return { written: true as const, nextRevision: String(revB) };
      },
      save: async () => undefined,
    };

    seedDocumentDraft(adapter, "a.ts", { text: "v0", revision: "1", byteLength: 2 });
    seedDocumentDraft(adapter, "b.ts", { text: "b0", revision: "10", byteLength: 2 });

    // Edit doc A and kick off first save while pending.
    expect(recordDocumentEdit(adapter, "a.ts", "v1")).toBe(true);
    const dirtyEvents: { readonly docId: string; readonly dirty: boolean }[] = [];
    const save1 = persistDocumentDraft(adapter, "a.ts", false, {
      onDirtyChange: (docId, dirty) => dirtyEvents.push({ docId, dirty }),
    });
    await firstWriteStarted;

    // User types v2 while save1 is in flight and switches to doc B.
    expect(recordDocumentEdit(adapter, "a.ts", "v2")).toBe(true);
    const save2 = persistDocumentDraft(adapter, "a.ts", false, {
      onDirtyChange: (docId, dirty) => dirtyEvents.push({ docId, dirty }),
    });

    // Release save1 -> doc A must STILL be dirty because v2 has not been written yet!
    resolveFirstWrite?.();
    await save1;
    expect(dirtyEvents[0]).toEqual({ docId: "a.ts", dirty: true });
    // Doc B's revision and clean state must remain completely untouched.
    expect(getDocumentDraft(adapter, "b.ts")?.revision).toBe("10");
    expect(isDraftDirty(getDocumentDraft(adapter, "b.ts")!)).toBe(false);

    // Wait for queued save2 -> writes v2 with expectedRevision "2" and clears dirty state.
    await save2;
    expect(writes).toEqual([
      { docId: "a.ts", text: "v1", expected: "1" },
      { docId: "a.ts", text: "v2", expected: "2" },
    ]);
    expect(getDocumentDraft(adapter, "a.ts")?.revision).toBe("3");
    expect(isDraftDirty(getDocumentDraft(adapter, "a.ts")!)).toBe(false);

    // Take-theirs cancels queued forced saves in flight and notifies split-pane subscribers in place.
    const paneNotifications = vi.fn();
    const unsubscribe = subscribeDocumentDraft(adapter, "a.ts", paneNotifications);

    let releaseBlockedWrite: (() => void) | undefined;
    let notifyBlockedStarted: (() => void) | undefined;
    const blockedStarted = new Promise<void>((resolve) => {
      notifyBlockedStarted = resolve;
    });
    const origWrite = adapter.writeIfUnchanged;
    adapter.writeIfUnchanged = async (docId, text, expected) => {
      writes.push({ docId, text, expected });
      if (text === "stale-1") {
        notifyBlockedStarted?.();
        await new Promise<void>((resolve) => {
          releaseBlockedWrite = resolve;
        });
      }
      return { written: true as const, nextRevision: "99" };
    };

    recordDocumentEdit(adapter, "a.ts", "stale-1");
    const blockingSave = persistDocumentDraft(adapter, "a.ts", false, {});
    await blockedStarted;
    recordDocumentEdit(adapter, "a.ts", "stale-2");
    const queuedForcedSave = persistDocumentDraft(adapter, "a.ts", true, {});

    // Take theirs replaces draft in place -> notifies split pane & invalidates queuedForcedSave!
    const replaced = replaceDocumentDraftFromDisk(adapter, "a.ts", {
      text: "disk-v9",
      revision: "9",
      byteLength: 7,
    });
    expect(replaced.text).toBe("disk-v9");
    expect(replaced.reloadSeq).toBe(1);
    expect(isDraftDirty(replaced)).toBe(false);
    expect(paneNotifications).toHaveBeenCalledTimes(1);

    releaseBlockedWrite?.();
    await blockingSave;
    await queuedForcedSave;
    adapter.writeIfUnchanged = origWrite;
    unsubscribe();

    // queuedForcedSave MUST NOT have written "stale-2", and blockingSave must NOT overwrite rev "9".
    expect(writes.some((w) => w.text === "stale-2")).toBe(false);
    expect(getDocumentDraft(adapter, "a.ts")?.revision).toBe("9");
    expect(getDocumentDraft(adapter, "a.ts")?.text).toBe("disk-v9");
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

    // Clipped anchor above clipRect.top must still clamp the dialog strictly inside clipRect.top.
    const clippedAbove = diagnosticPeekPlacement({
      anchorRect: { top: -80, bottom: -60, left: 20, right: 100, width: 80, height: 20 },
      clipRect: { top: 40, bottom: 300, left: 10, right: 500, width: 490, height: 260 },
      layerRect: { top: 40, bottom: 300, left: 10, right: 500, width: 490, height: 260 },
      surfaceHeight: 120,
      surfaceWidth: 300,
    });
    expect(clippedAbove.top).toBe(0);

    const onCloseA = vi.fn();
    const onCloseB = vi.fn();
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

    const peekModel = {
      severity: "error" as const,
      message: "Type string is not assignable to number",
      source: "ts",
      code: "2322",
      geometry: {
        kind: "visible" as const,
        anchorRect: { top: 40, bottom: 60, left: 20, right: 80, width: 60, height: 20 },
        clipRect: { top: 0, bottom: 400, left: 0, right: 500, width: 500, height: 400 },
      },
      relatedInformation: [{ label: "Declared here", target: { path: "src/types.ts", line: 9, column: 3 } }],
    };

    const host = mount(
      <div>
        <button type="button" data-testid="outside-btn">
          Outside
        </button>
        <LspStatusBadge adapter={lspAdapter} />
        <DiagnosticPeek model={peekModel} onClose={(r) => onCloseA(r)} onOpenTarget={onOpenTarget} />
        <DiagnosticPeek model={peekModel} onClose={(r) => onCloseB(r)} />
      </div>,
    );

    expect(host.querySelector('[data-testid="wb-lsp-status"]')?.textContent).toContain("2E · 1W");

    // Moving focus outside and re-rendering with fresh inline onClose closures must NOT steal focus.
    const outsideBtn = host.querySelector<HTMLButtonElement>('[data-testid="outside-btn"]');
    outsideBtn?.focus();
    expect(document.activeElement).toBe(outsideBtn);
    act(() => {
      activeRoot?.render(
        <WorkbenchPortalProvider>
          <div>
            <button type="button" data-testid="outside-btn">
              Outside
            </button>
            <LspStatusBadge adapter={lspAdapter} />
            <DiagnosticPeek model={peekModel} onClose={(r) => onCloseA(r)} onOpenTarget={onOpenTarget} />
            <DiagnosticPeek model={peekModel} onClose={(r) => onCloseB(r)} />
          </div>
        </WorkbenchPortalProvider>,
      );
    });
    expect(document.activeElement).toBe(outsideBtn);

    // Escape outside both dialogs closes neither dialog.
    act(() => {
      outsideBtn?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(onCloseA).not.toHaveBeenCalled();
    expect(onCloseB).not.toHaveBeenCalled();

    // Escape inside peek A closes ONLY peek A (not peek B).
    const peeks = host.querySelectorAll<HTMLDivElement>('[data-testid="wb-diagnostic-peek"]');
    peeks[0]?.focus();
    act(() => {
      peeks[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(onCloseA).toHaveBeenCalledWith(true);
    expect(onCloseB).not.toHaveBeenCalled();

    act(() => {
      host.querySelector<HTMLButtonElement>('[data-testid="wb-diagnostic-related-0"]')?.click();
    });
    expect(onCloseA).toHaveBeenCalledWith(false);
    expect(onOpenTarget).toHaveBeenCalledWith({ path: "src/types.ts", line: 9, column: 3 });
  });

  it("parses @file mentions and /slash triggers with reversible encoding for commas, brackets, and backslashes", () => {
    expect(formatMentionToken("src/App.tsx")).toBe("@src/App.tsx");
    expect(formatMentionToken("docs/my guide.md")).toBe("@[docs/my guide.md]");
    expect(formatMentionToken("src/a,b.ts")).toBe("@[src/a,b.ts]");
    expect(formatMentionToken("docs/closing ] bracket.md")).toBe("@[docs/closing \\] bracket.md]");
    expect(formatMentionToken("docs/sub\\path.md")).toBe("@[docs/sub\\\\path.md]");
    expect(formatMentionToken("docs/trailing.md ")).toBe("@[docs/trailing.md ]");
    expect(formatMentionToken(" leading.md")).toBe("@[ leading.md]");

    const trickyPaths = [
      "src/App.tsx",
      "docs/my guide.md",
      "src/a,b.ts",
      "docs/closing ] bracket.md",
      "docs/sub\\path.md",
      "docs/trailing.md ",
      " leading.md",
    ];
    const sentence = `Review ${trickyPaths.map((p) => formatMentionToken(p)).join(" and ")}, ignore user@example.com`;
    const mentions = findMentionRanges(sentence);
    expect(mentions.map((m) => m.path)).toEqual(trickyPaths);
    const knownSet = new Set(trickyPaths);
    expect(findMentionRanges(sentence, knownSet).map((m) => m.path)).toEqual(trickyPaths);

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
