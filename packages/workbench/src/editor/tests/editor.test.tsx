import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  ActivationFocusDecision,
  DocumentConflict,
  EditorDocumentAdapter,
  EditorGroupsSnapshot,
  EditorTabDescriptor,
  LspHostAdapter,
  LspServerStatus,
  Subscribable,
  WriteOutcome,
} from "../../core/index";
import { WorkbenchPortalProvider } from "../../ui/index";
import {
  createAnchorSelection,
  createEditorBufferSession,
  createEditorTextBuffer,
  createEditorViewSession,
  createSelectionSet,
  createStringTextSnapshot,
} from "@singapore-editor/core/document";
import type { Editor } from "@singapore-editor/core/editor";
import type { EditorInlineReplacementProvider, EditorViewSnapshot } from "@singapore-editor/core/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildWorkbenchEditorTheme,
  capOverscrollTop,
  clampRestoredScroll,
  CodeEditor,
  createWorkbenchEditorPlugins,
  DEFAULT_MAX_ANALYSIS_BYTES,
  documentFeatureTier,
  EditorTabBar,
  languageIdForPath,
  languageLabelForPath,
  type EditorRevealTarget,
  type EditorSessionAttachment,
} from "../index";
import {
  computeIncrementalUtf8Delta,
  getDocumentDraft,
  isDraftDirty,
  persistDocumentDraft,
  replaceDocumentDraftFromDisk,
  resolveDocumentConflict,
  seedDocumentDraft,
  subscribeDocumentDraft,
  utf8ByteLength,
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
    expect(languageIdForPath("setup.sh")).toBe("shellscript");
    expect(languageIdForPath("scripts/init.bash")).toBe("shellscript");
    expect(languageIdForPath("scripts/env.zsh")).toBe("shellscript");
    expect(languageIdForPath("scripts/env.ksh")).toBe("shellscript");
    expect(languageIdForPath("/home/user/.bashrc")).toBe("shellscript");
    expect(languageIdForPath(".zshrc")).toBe("shellscript");
    expect(languageIdForPath("notes.unknown")).toBeNull();
    expect(languageIdForPath("file.__proto__")).toBeNull();
    expect(languageIdForPath("file.constructor")).toBeNull();
    expect(languageLabelForPath("src/App.tsx")).toBe("TypeScript JSX");
    expect(languageLabelForPath("src/App.vue")).toBe("Vue");
    expect(languageLabelForPath("setup.sh")).toBe("Shell");
    expect(languageLabelForPath("scripts/env.ksh")).toBe("Shell");
    expect(languageLabelForPath(".zshrc")).toBe("Shell");
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
    expect(onReorder).toHaveBeenCalledWith("main", 0, 1, "src/a/index.ts");
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
    // Drag A past C, then back between B and C, then drop: emits exactly ONE reorder (0 -> 1, "a").
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
    expect(onReorder).not.toHaveBeenCalled();
    act(() => {
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 10,
          pointerType: "mouse",
          clientX: 180,
        }),
      );
    });
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith("g1", 0, 1, "a");

    // Dragging A past C and returning it to slot 0 before dropping emits zero reorders.
    onReorder.mockClear();
    act(() => {
      tabEls[0]?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 11,
          pointerType: "mouse",
          clientX: 40,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 11,
          pointerType: "mouse",
          clientX: 280,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 11,
          pointerType: "mouse",
          clientX: 30,
        }),
      );
    });
    expect(onReorder).not.toHaveBeenCalled();

    // Changing groupId while dragging cancels the gesture instead of emitting a reorder for g2.
    onReorder.mockClear();
    act(() => {
      tabEls[0]?.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerId: 12,
          pointerType: "mouse",
          clientX: 40,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 12,
          pointerType: "mouse",
          clientX: 280,
        }),
      );
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
          pointerId: 12,
          pointerType: "mouse",
          clientX: 280,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          pointerId: 12,
          pointerType: "mouse",
          clientX: 280,
        }),
      );
    });
    expect(onReorder).not.toHaveBeenCalled();

    // Returning to g1 after the cancelled drag must NOT resurrect stale data-dragging styling on tab A.
    act(() => {
      activeRoot?.render(
        <WorkbenchPortalProvider>
          <EditorTabBar
            groupId="g1"
            tabs={tabs}
            selectedTabId="a"
            onSelectTab={onSelect}
            onCloseTab={onClose}
            onReorderTab={onReorder}
          />
        </WorkbenchPortalProvider>,
      );
    });
    const restoredA = host.querySelector<HTMLElement>('[data-wb-tab][data-tab-id="a"]');
    expect(restoredA?.getAttribute("data-dragging")).toBeNull();
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

  it("preserves live EditorTextBuffer drafts, breaks typing runs on save, handles save rejections, and serializes Take theirs / Keep mine", async () => {
    let resolveFirstWrite: (() => void) | undefined;
    let notifyFirstWriteStarted: (() => void) | undefined;
    const firstWriteStarted = new Promise<void>((resolve) => {
      notifyFirstWriteStarted = resolve;
    });
    const writes: { readonly docId: string; readonly text: string; readonly expected?: string }[] = [];
    const conflictChoices: string[] = [];
    let revA = 1;
    let revB = 10;
    let failNextSave = false;
    let diskTextA = "disk-v9";

    const adapter: EditorDocumentAdapter = {
      getConflict: () => createSubscribable<DocumentConflict | undefined>(undefined),
      loadDocument: async (docId) =>
        docId === "a.ts"
          ? { text: diskTextA, revision: "9", byteLength: utf8ByteLength(diskTextA) }
          : undefined,
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
      async save() {
        if (failNextSave) {
          failNextSave = false;
          throw new Error("disk full");
        }
      },
      async resolveConflict(_docId, choice) {
        conflictChoices.push(choice);
      },
    };

    const draftA = seedDocumentDraft(adapter, "a.ts", { text: "v0", revision: "1", byteLength: 2 });
    const draftB = seedDocumentDraft(adapter, "b.ts", { text: "b0", revision: "10", byteLength: 2 });
    const materializeSpy = vi.spyOn(draftA.buffer, "materializeFullText");

    const replaceAll = (entry: typeof draftA, text: string) => {
      const snap = entry.buffer.getSnapshot();
      const sel = createSelectionSet([createAnchorSelection(snap, 0, snap.length)]);
      entry.buffer.applyText(sel, text);
    };

    // Edit + undo clears dirty back to false with ZERO materializeFullText calls.
    replaceAll(draftA, "v1");
    expect(isDraftDirty(draftA)).toBe(true);
    expect(materializeSpy).toHaveBeenCalledTimes(0);
    draftA.buffer.undo();
    expect(isDraftDirty(draftA)).toBe(false);
    expect(draftA.buffer.isDirty()).toBe(false);
    expect(materializeSpy).toHaveBeenCalledTimes(0);

    // Edit doc A and kick off first save while pending (materializeFullText called ONCE for write payload).
    replaceAll(draftA, "v1");
    expect(isDraftDirty(draftA)).toBe(true);
    const dirtyEvents: { readonly docId: string; readonly dirty: boolean }[] = [];
    const save1 = persistDocumentDraft(adapter, "a.ts", false, {
      onDirtyChange: (docId, dirty) => dirtyEvents.push({ docId, dirty }),
    });
    await firstWriteStarted;
    expect(materializeSpy).toHaveBeenCalledTimes(1);

    // User types while save1 is in flight (after breakTypingRun sealed v1 as an undo boundary).
    const snapMid = draftA.buffer.getSnapshot();
    const endSel = createSelectionSet([createAnchorSelection(snapMid, snapMid.length, snapMid.length)]);
    draftA.buffer.applyText(endSel, "+mid");
    expect(draftA.buffer.getTextSnapshot().materializeFullText()).toBe("v1+mid");

    // Release save1 -> doc A must STILL be dirty because "+mid" was not written yet!
    resolveFirstWrite?.();
    await save1;
    expect(dirtyEvents[0]).toEqual({ docId: "a.ts", dirty: true });
    expect(isDraftDirty(draftA)).toBe(true);
    expect(draftB.revision).toBe("10");
    expect(isDraftDirty(draftB)).toBe(false);

    // Undo once returns cleanly to the sealed v1 saved checkpoint and clears dirty to false!
    draftA.buffer.undo();
    expect(draftA.buffer.getTextSnapshot().materializeFullText()).toBe("v1");
    expect(isDraftDirty(draftA)).toBe(false);
    expect(draftA.buffer.isDirty()).toBe(false);

    // Redo brings "+mid" back (dirty again) and saving clears dirty on the newer revision.
    draftA.buffer.redo();
    expect(isDraftDirty(draftA)).toBe(true);
    await persistDocumentDraft(adapter, "a.ts", false, {
      onDirtyChange: (docId, dirty) => dirtyEvents.push({ docId, dirty }),
    });
    expect(writes).toEqual([
      { docId: "a.ts", text: "v1", expected: "1" },
      { docId: "a.ts", text: "v1+mid", expected: "2" },
    ]);
    expect(draftA.revision).toBe("3");
    expect(isDraftDirty(draftA)).toBe(false);

    // adapter.save() rejection leaves draft dirty while retaining entry.revision = nextRevision for retry.
    replaceAll(draftA, "retry-me");
    failNextSave = true;
    const onSaveSpy = vi.fn();
    await expect(persistDocumentDraft(adapter, "a.ts", false, { onSave: onSaveSpy })).rejects.toThrow(
      "disk full",
    );
    expect(onSaveSpy).not.toHaveBeenCalled();
    expect(draftA.revision).toBe("4");
    expect(isDraftDirty(draftA)).toBe(true);

    // Retrying save sends expectedRevision "4" (no false conflict) and clears dirty.
    await persistDocumentDraft(adapter, "a.ts", false, { onSave: onSaveSpy });
    expect(writes.at(-1)).toEqual({ docId: "a.ts", text: "retry-me", expected: "4" });
    expect(onSaveSpy).toHaveBeenCalledTimes(1);
    expect(draftA.revision).toBe("5");
    expect(isDraftDirty(draftA)).toBe(false);

    // In-flight Save 1 -> queued Save 2 -> "Take theirs": Save 2 NEVER writes, "Take theirs" waits for Save 1!
    const eventsOrder: string[] = [];
    let releaseBlockedWrite: (() => void) | undefined;
    let notifyBlockedStarted: (() => void) | undefined;
    const blockedStarted = new Promise<void>((resolve) => {
      notifyBlockedStarted = resolve;
    });
    const origWrite = adapter.writeIfUnchanged;
    const origResolve = adapter.resolveConflict;
    adapter.writeIfUnchanged = async (docId, text, expected) => {
      writes.push({ docId, text, expected });
      eventsOrder.push(`write:${text}`);
      if (text === "stale-1") {
        notifyBlockedStarted?.();
        await new Promise<void>((resolve) => {
          releaseBlockedWrite = resolve;
        });
        eventsOrder.push("write-done:stale-1");
      }
      return { written: true as const, nextRevision: "99" };
    };
    adapter.resolveConflict = async (docId, choice) => {
      eventsOrder.push(`resolve:${choice}`);
      await origResolve?.(docId, choice);
    };

    const paneNotifications = vi.fn();
    const unsubscribe = subscribeDocumentDraft(adapter, "a.ts", paneNotifications);

    replaceAll(draftA, "stale-1");
    const blockingSave = persistDocumentDraft(adapter, "a.ts", false, {});
    await blockedStarted;
    replaceAll(draftA, "stale-2");
    const queuedSave2 = persistDocumentDraft(adapter, "a.ts", true, {});

    // Trigger "Take theirs" while Save 1 is in flight and Save 2 is queued.
    const takeTheirsPromise = resolveDocumentConflict(adapter, "a.ts", "take-theirs", {
      onDirtyChange: (docId, dirty) => dirtyEvents.push({ docId, dirty }),
    });
    expect(draftA.resolvingConflict).toBe(true);
    // A second concurrent resolution call on another pane is ignored while resolvingConflict is true.
    await resolveDocumentConflict(adapter, "a.ts", "keep-mine", {});
    expect(eventsOrder).toEqual(["write:stale-1"]);

    releaseBlockedWrite?.();
    await Promise.all([blockingSave, queuedSave2, takeTheirsPromise]);
    expect(draftA.resolvingConflict).toBe(false);
    expect(eventsOrder).toEqual(["write:stale-1", "write-done:stale-1", "resolve:take-theirs"]);
    expect(writes.some((w) => w.text === "stale-2")).toBe(false);
    expect(draftA.revision).toBe("9");
    expect(draftA.buffer.getTextSnapshot().materializeFullText()).toBe("disk-v9");
    expect(isDraftDirty(draftA)).toBe(false);
    expect(paneNotifications).toHaveBeenCalled();

    // "keep-mine" invokes resolveConflict("keep-mine") then forced write preserving onWriteConflict / onSave.
    const conflictOutcomes: Extract<WriteOutcome, { readonly written: false }>[] = [];
    adapter.writeIfUnchanged = async (_docId, _text, expected) => {
      expect(expected).toBeUndefined();
      return { written: false as const, currentText: "disk-v10", currentRevision: "10" };
    };
    replaceAll(draftA, "mine-text");
    await resolveDocumentConflict(adapter, "a.ts", "keep-mine", {
      onWriteConflict: (_docId, outcome) => conflictOutcomes.push(outcome),
    });
    expect(conflictOutcomes).toHaveLength(1);
    expect(isDraftDirty(draftA)).toBe(true);

    const keepMineSaved = vi.fn();
    adapter.writeIfUnchanged = origWrite;
    adapter.resolveConflict = origResolve;
    await resolveDocumentConflict(adapter, "a.ts", "keep-mine", {
      onSave: keepMineSaved,
    });
    expect(keepMineSaved).toHaveBeenCalledWith("a.ts");
    expect(isDraftDirty(draftA)).toBe(false);

    // Direct replaceDocumentDraftFromDisk also updates buffer in place and clears dirty.
    replaceAll(draftA, "temp");
    const replaced = replaceDocumentDraftFromDisk(adapter, "a.ts", {
      text: "fresh-disk",
      revision: "12",
      byteLength: 10,
    });
    expect(replaced.buffer.getTextSnapshot().materializeFullText()).toBe("fresh-disk");
    expect(replaced.revision).toBe("12");
    expect(isDraftDirty(replaced)).toBe(false);

    unsubscribe();
    materializeSpy.mockRestore();
  });

  it("tracks exact UTF-8 byte lengths across non-ASCII and split/joined UTF-16 surrogate pairs without materializeFullText", () => {
    const encoder = new TextEncoder();
    const adapter: EditorDocumentAdapter = {
      getConflict: () => createSubscribable(undefined),
      loadDocument: async () => undefined,
      writeIfUnchanged: async () => ({ written: true as const, nextRevision: "2" }),
      save: async () => undefined,
    };

    const initial = "a😀b"; // 1 + 4 + 1 = 6 bytes
    const draft = seedDocumentDraft(adapter, "unicode.ts", {
      text: initial,
      revision: "1",
      byteLength: encoder.encode(initial).byteLength,
    });
    const materializeSpy = vi.spyOn(draft.buffer, "materializeFullText");

    const assertMatchesEncoder = () => {
      const actual = draft.buffer.getTextSnapshot().materializeFullText();
      expect(draft.byteLength).toBe(encoder.encode(actual).byteLength);
    };

    // 1. Direct split/rejoin delta across a UTF-16 surrogate pair boundary ("a😀b" 6B <-> "a\uD83DX\uDE00b" 9B).
    const beforeSplit = createStringTextSnapshot("a\uD83D\uDE00b");
    const afterSplit = createStringTextSnapshot("a\uD83DX\uDE00b");
    expect(
      computeIncrementalUtf8Delta(beforeSplit as never, afterSplit as never, [{ from: 2, to: 2, text: "X" }]),
    ).toBe(3);
    expect(
      computeIncrementalUtf8Delta(afterSplit as never, beforeSplit as never, [{ from: 2, to: 3, text: "" }]),
    ).toBe(-3);

    // 2. Adjacent buffer edit next to an astral pair stays exact even when Singapore snaps code-point boundaries.
    let snap = draft.buffer.getSnapshot();
    draft.buffer.applyEdits(createSelectionSet([createAnchorSelection(snap, 2, 2)]), [
      { from: 2, to: 2, text: "X" },
    ]);
    assertMatchesEncoder();

    // 3. Insert lone low surrogate "\uDE00" then prepend high surrogate "\uD83D" immediately before it (3 -> 4 bytes, delta +1).
    snap = draft.buffer.getSnapshot();
    draft.buffer.applyEdits(createSelectionSet([createAnchorSelection(snap, 0, 0)]), [
      { from: 0, to: 0, text: "\uDE00" },
    ]);
    assertMatchesEncoder();
    const bytesBeforeJoinLeft = draft.byteLength;
    snap = draft.buffer.getSnapshot();
    draft.buffer.applyEdits(createSelectionSet([createAnchorSelection(snap, 0, 0)]), [
      { from: 0, to: 0, text: "\uD83D" },
    ]);
    assertMatchesEncoder();
    expect(draft.byteLength - bytesBeforeJoinLeft).toBe(1);

    // 4. Insert lone high surrogate "\uD83D" at end, then append low surrogate "\uDE00" immediately after it (3 -> 4 bytes, delta +1).
    snap = draft.buffer.getSnapshot();
    draft.buffer.applyEdits(createSelectionSet([createAnchorSelection(snap, snap.length, snap.length)]), [
      { from: snap.length, to: snap.length, text: "\uD83D" },
    ]);
    assertMatchesEncoder();
    const bytesBeforeJoinRight = draft.byteLength;
    snap = draft.buffer.getSnapshot();
    draft.buffer.applyEdits(createSelectionSet([createAnchorSelection(snap, snap.length, snap.length)]), [
      { from: snap.length, to: snap.length, text: "\uDE00" },
    ]);
    assertMatchesEncoder();
    expect(draft.byteLength - bytesBeforeJoinRight).toBe(1);

    // 5. Insert multi-byte CJK + emoji simultaneously at two non-overlapping cursors.
    snap = draft.buffer.getSnapshot();
    draft.buffer.applyEdits(createSelectionSet([createAnchorSelection(snap, 0, 0)]), [
      { from: 0, to: 0, text: "你好" },
      { from: snap.length, to: snap.length, text: "🚀" },
    ]);
    assertMatchesEncoder();

    // Zero calls to buffer.materializeFullText throughout all edits!
    expect(materializeSpy).not.toHaveBeenCalled();
    materializeSpy.mockRestore();
  });

  it("shares one live EditorTextBuffer across split CodeEditor panes with independent views and flips maxAnalysisBytes live", async () => {
    const conflictSub = createSubscribable<DocumentConflict | undefined>(undefined);
    const adapter: EditorDocumentAdapter = {
      maxAnalysisBytes: 12,
      getConflict: () => conflictSub,
      loadDocument: async () => ({ text: "hello", revision: "1", byteLength: 5 }),
      writeIfUnchanged: async () => ({ written: true as const, nextRevision: "2" }),
      save: async () => undefined,
      resolveConflict: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      },
    };

    const editors: (Editor | null)[] = [null, null];
    const dirtyCalls: { readonly pane: number; readonly dirty: boolean }[] = [];

    const host = mount(
      <div>
        <CodeEditor
          adapter={adapter}
          documentId="shared.ts"
          path="shared.ts"
          highlighting={false}
          onDirtyChange={(_id, dirty) => dirtyCalls.push({ pane: 0, dirty })}
          onEditorReady={(ed) => {
            editors[0] = ed;
          }}
        />
        <CodeEditor
          adapter={adapter}
          documentId="shared.ts"
          path="shared.ts"
          highlighting={false}
          onDirtyChange={(_id, dirty) => dirtyCalls.push({ pane: 1, dirty })}
          onEditorReady={(ed) => {
            editors[1] = ed;
          }}
        />
      </div>,
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const draft = getDocumentDraft(adapter, "shared.ts")!;
    expect(draft).toBeDefined();
    const editorEls = Array.from(host.querySelectorAll<HTMLElement>("[data-wb-editor]"));
    expect(editorEls).toHaveLength(2);
    expect(editorEls[0]?.dataset.analysisAllowed).toBe("true");
    expect(editorEls[1]?.dataset.analysisAllowed).toBe("true");

    // Independent view sessions over the same live buffer: selection in pane 0 does not move pane 1's selection.
    expect(editors[0]).not.toBeNull();
    expect(editors[1]).not.toBeNull();
    act(() => {
      editors[0]!.setSelection(0, 3);
      editors[1]!.setSelection(5, 5);
    });
    expect(editors[0]!.getState().cursor).toEqual({ row: 0, column: 3 });
    expect(editors[1]!.getState().cursor).toEqual({ row: 0, column: 5 });

    // Editing through pane 0's editor updates pane 1 live AND crosses maxAnalysisBytes (12 bytes) with multi-byte UTF-8!
    act(() => {
      editors[0]!.edit({ from: 5, to: 5, text: "😀😀" }); // 5 + 8 = 13 > 12 bytes
    });
    expect(editors[1]!.getTextSnapshot().materializeFullText()).toBe("hello😀😀");
    expect(editorEls[0]?.dataset.analysisAllowed).toBe("false");
    expect(editorEls[1]?.dataset.analysisAllowed).toBe("false");
    expect(host.querySelectorAll('[data-testid="wb-editor-large-file-notice"]')).toHaveLength(2);

    // Undoing drops back under 12 bytes -> restores analysisAllowed and clears dirty in both panes.
    act(() => {
      draft.buffer.undo();
    });
    expect(editorEls[0]?.dataset.analysisAllowed).toBe("true");
    expect(editorEls[1]?.dataset.analysisAllowed).toBe("true");
    expect(dirtyCalls.filter((c) => c.pane === 0).at(-1)?.dirty).toBe(false);
    expect(dirtyCalls.filter((c) => c.pane === 1).at(-1)?.dirty).toBe(false);

    // Cross-pane resolvingConflict disables conflict buttons in BOTH panes simultaneously.
    act(() => {
      conflictSub.set({ documentId: "shared.ts", path: "shared.ts", diskText: "external" });
    });
    const keepButtons = Array.from(
      host.querySelectorAll<HTMLButtonElement>('[data-testid="wb-editor-conflict-keep"]'),
    );
    expect(keepButtons).toHaveLength(2);
    act(() => {
      keepButtons[0]?.click();
    });
    expect(keepButtons[0]?.disabled).toBe(true);
    expect(keepButtons[1]?.disabled).toBe(true);
  });

  it("preserves Sprockt session-mode contract: persistent editor, onBeforeDetach before swap & unmount, reveal.seq, scroll clamp, and fonts.ready", async () => {
    const bufA = createEditorTextBuffer("line 1\nline 2\nline 3");
    const sessionA = createEditorBufferSession(bufA, createEditorViewSession(bufA));
    const bufB = createEditorTextBuffer("alpha\nbeta\ngamma");
    const sessionB = createEditorBufferSession(bufB, createEditorViewSession(bufB));

    const attachmentA: EditorSessionAttachment = {
      session: sessionA,
      documentId: "a.ts",
      languageId: "typescript",
      scrollPosition: { left: 0, top: 9999 },
    };
    const attachmentB: EditorSessionAttachment = {
      session: sessionB,
      documentId: "b.ts",
      languageId: "typescript",
    };

    const events: string[] = [];
    const seenEditors = new Set<Editor>();
    let latestEditor: Editor | null = null;
    let fontsResolve: (() => void) | undefined;
    const origFonts = document.fonts;
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        ready: new Promise<void>((resolve) => {
          fontsResolve = resolve;
        }),
      },
    });

    const renderSession = (
      session: EditorSessionAttachment | null,
      reveal: EditorRevealTarget | null = null,
    ) => (
      <CodeEditor
        session={session}
        fontFamily="JetBrains Mono"
        highlighting={false}
        reveal={reveal}
        onEditorReady={(ed) => {
          if (ed) {
            seenEditors.add(ed);
            latestEditor = ed;
          }
        }}
        onBeforeDetach={(att) => events.push(`beforeDetach:${att.documentId}`)}
        onAttached={(_ed, att) => events.push(`attached:${att.documentId}`)}
        onDetached={() => events.push("detached")}
        emptyState={<div data-testid="session-empty">No file</div>}
      />
    );

    try {
      const host = mount(renderSession(attachmentA, { line: 2, column: 3, focus: true, seq: 1 }));
      expect(seenEditors.size).toBe(1);
      expect(latestEditor).not.toBeNull();
      const setFontFamilySpy = vi.spyOn(latestEditor!, "setFontFamily");
      const jumpToSpy = vi.spyOn(latestEditor!, "jumpTo");
      expect(events).toEqual(["attached:a.ts"]);

      // Fonts ready triggers font family remeasurement on the live editor.
      await act(async () => {
        fontsResolve?.();
        await Promise.resolve();
      });
      expect(setFontFamilySpy).toHaveBeenCalledWith("JetBrains Mono");

      // Duplicate reveal seq=1 is ignored; monotonic seq=2 jumps to line 3 col 2.
      act(() => {
        activeRoot?.render(
          <WorkbenchPortalProvider>
            {renderSession(attachmentA, { line: 1, column: 1, seq: 1 })}
          </WorkbenchPortalProvider>,
        );
      });
      expect(jumpToSpy).not.toHaveBeenCalled();
      act(() => {
        activeRoot?.render(
          <WorkbenchPortalProvider>
            {renderSession(attachmentA, { line: 3, column: 2, seq: 2 })}
          </WorkbenchPortalProvider>,
        );
      });
      expect(jumpToSpy).toHaveBeenCalledTimes(1);

      // Swapping to attachmentB fires onBeforeDetach(a.ts) before attaching b.ts on the SAME editor instance.
      act(() => {
        activeRoot?.render(<WorkbenchPortalProvider>{renderSession(attachmentB)}</WorkbenchPortalProvider>);
      });
      expect(seenEditors.size).toBe(1);
      expect(events).toEqual(["attached:a.ts", "beforeDetach:a.ts", "attached:b.ts"]);

      // Clearing to null detaches b.ts and shows emptyState without destroying the editor instance.
      act(() => {
        activeRoot?.render(<WorkbenchPortalProvider>{renderSession(null)}</WorkbenchPortalProvider>);
      });
      expect(host.querySelector('[data-testid="session-empty"]')).not.toBeNull();
      expect(events).toEqual([
        "attached:a.ts",
        "beforeDetach:a.ts",
        "attached:b.ts",
        "beforeDetach:b.ts",
        "detached",
      ]);

      // Re-attaching a.ts then unmounting fires layout-effect beforeDetach + detached before editor disposal.
      act(() => {
        activeRoot?.render(<WorkbenchPortalProvider>{renderSession(attachmentA)}</WorkbenchPortalProvider>);
      });
      act(() => {
        activeRoot?.unmount();
        activeRoot = null;
      });
      expect(events.slice(-3)).toEqual(["attached:a.ts", "beforeDetach:a.ts", "detached"]);
    } finally {
      Object.defineProperty(document, "fonts", { configurable: true, value: origFonts });
    }
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

  it("reads canonical syntax and warning tokens (including oklch values) in buildWorkbenchEditorTheme", () => {
    const host = document.createElement("div");
    host.dataset.wbColorScheme = "dark";
    host.style.setProperty("--wb-bg-well", "oklch(0.18 0.02 250)");
    host.style.setProperty("--wb-fg", "oklch(0.92 0.01 250)");
    host.style.setProperty("--wb-warn", "oklch(0.78 0.16 75)");
    host.style.setProperty("--wb-syn-function", "oklch(0.76 0.14 230)");
    host.style.setProperty("--wb-syn-property", "oklch(0.74 0.12 190)");
    host.style.setProperty("--wb-syn-attr", "oklch(0.72 0.14 45)");
    host.style.setProperty("--wb-syn-variable", "oklch(0.88 0.04 260)");
    document.body.appendChild(host);
    try {
      const theme = buildWorkbenchEditorTheme(host);
      expect(theme.backgroundColor).toBe("oklch(0.18 0.02 250)");
      expect(theme.foregroundColor).toBe("oklch(0.92 0.01 250)");
      expect(theme.colors?.["lsp.diagnostic.warningBackground"]).toBe(
        "color-mix(in oklab, oklch(0.78 0.16 75) 20%, transparent)",
      );
      expect(theme.syntax?.function).toBe("oklch(0.76 0.14 230)");
      expect(theme.syntax?.property).toBe("oklch(0.74 0.12 190)");
      expect(theme.syntax?.attribute).toBe("oklch(0.72 0.14 45)");
      expect(theme.syntax?.variable).toBe("oklch(0.88 0.04 260)");
    } finally {
      host.remove();
    }
  });
});
