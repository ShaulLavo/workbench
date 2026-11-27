import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createStringTextSnapshot } from "@singapore-editor/core/document";
import type { EditorInlineReplacementProvider } from "@singapore-editor/core/extensions";
import { afterEach, describe, expect, it, vi } from "vitest";

interface FakeEditorRecord {
  documentId: string;
  text: string;
  cursor: { row: number; column: number };
  materializeCalls: number;
  setProviderCalls: number;
  provider: EditorInlineReplacementProvider | null;
  onChange?: (state: { cursor: { row: number; column: number }; selectionCount: number }) => void;
  snapshot: ReturnType<typeof createStringTextSnapshot>;
  emitChange(): void;
  setText(next: string, cursor?: { row: number; column: number }): void;
  readonly editor: {
    setInlineReplacementProvider: (
      provider: EditorInlineReplacementProvider | null,
      options?: { readonly trigger?: string },
    ) => void;
  };
}

const fakeEditors: FakeEditorRecord[] = [];
const controllerToRecord = new WeakMap<object, FakeEditorRecord>();

function cursorAtEnd(text: string): { row: number; column: number } {
  const lines = text.split("\n");
  return { row: lines.length - 1, column: (lines.at(-1) ?? "").length };
}

vi.mock("@singapore-editor/react", () => ({
  useEditor(options: {
    readonly document: { readonly documentId: string; readonly defaultText?: string };
    readonly onChange?: (state: { cursor: { row: number; column: number }; selectionCount: number }) => void;
  }) {
    let record = fakeEditors.find((entry) => entry.documentId === options.document.documentId);
    if (!record) {
      const initial = options.document.defaultText ?? "";
      const created: FakeEditorRecord = {
        documentId: options.document.documentId,
        text: initial,
        cursor: cursorAtEnd(initial),
        materializeCalls: 0,
        setProviderCalls: 0,
        provider: null,
        onChange: options.onChange,
        snapshot: createStringTextSnapshot(initial),
        emitChange() {
          this.onChange?.({ cursor: this.cursor, selectionCount: 1 });
        },
        setText(next: string, cursor?: { row: number; column: number }) {
          this.text = next;
          this.snapshot = createStringTextSnapshot(next);
          this.cursor = cursor ?? cursorAtEnd(next);
          this.emitChange();
        },
        editor: {
          setInlineReplacementProvider(provider) {
            created.setProviderCalls += 1;
            created.provider = provider;
          },
        },
      };
      fakeEditors.push(created);
      record = created;
    }
    record.onChange = options.onChange;

    const controller = {
      ref: () => {},
      getTextSnapshot: () => record.snapshot,
      materializeFullText: () => {
        record.materializeCalls += 1;
        return record.text;
      },
      commands: {
        focus: () => {},
        edit(
          change: { readonly from: number; readonly to: number; readonly text: string },
          opts?: { readonly selection?: { readonly anchor: number } },
        ) {
          const next = record.text.slice(0, change.from) + change.text + record.text.slice(change.to);
          const anchor = opts?.selection?.anchor ?? change.from + change.text.length;
          const prefix = next.slice(0, anchor);
          record.setText(next, cursorAtEnd(prefix));
        },
        setText(next: string) {
          record.setText(next);
        },
      },
    };
    controllerToRecord.set(controller, record);
    return controller;
  },
  useEditorSelector(controller: object, selector: (snapshot: { readonly editor: unknown }) => unknown) {
    const record = controllerToRecord.get(controller);
    return selector({ editor: record?.editor ?? null });
  },
}));

import { MarkdownComposer, type MarkdownComposerHandle } from "../composer/markdown-composer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let activeRoot: Root | null = null;
let activeHost: HTMLDivElement | null = null;

function mount(element: React.ReactElement): HTMLDivElement {
  activeHost = document.createElement("div");
  document.body.appendChild(activeHost);
  activeRoot = createRoot(activeHost);
  act(() => {
    activeRoot?.render(element);
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
  fakeEditors.length = 0;
});

describe("MarkdownComposer Phase 1A contracts", () => {
  it("assigns distinct documentIds to two independent composer instances", () => {
    mount(
      <>
        <MarkdownComposer defaultValue="First" />
        <MarkdownComposer defaultValue="Second" />
      </>,
    );
    expect(fakeEditors).toHaveLength(2);
    expect(fakeEditors[0]!.documentId).not.toBe(fakeEditors[1]!.documentId);
  });

  it("handles line-2+ @mention and /slash triggers with exact document offsets and multiline bracketed submit round-trips", () => {
    const submitted: { readonly text: string; readonly mentions: readonly string[] }[] = [];
    const selectedCommands: string[] = [];
    const ref = createRef<MarkdownComposerHandle>();
    const mentionItems = [
      { id: "1", path: "docs/closing ] bracket.md" },
      { id: "2", path: "src/App.tsx" },
    ];
    const slashCommands = [{ id: "fix", name: "fix", description: "Fix issue", insertText: "/fix " }];

    const host = mount(
      <MarkdownComposer
        ref={ref}
        defaultValue={"Line 1 intro\nInspect @clos"}
        mentionItems={mentionItems}
        slashCommands={slashCommands}
        onSubmit={(payload) => submitted.push(payload)}
        onSelectCommand={(cmd) => selectedCommands.push(cmd.name)}
      />,
    );
    const editorRec = fakeEditors[0]!;
    act(() => {
      editorRec.emitChange();
    });

    // Mention popup opens on line 2 and replaces only "@clos", leaving line 1 untouched.
    const mentionOpt = host.querySelector<HTMLButtonElement>('[data-testid="wb-composer-mention-option-1"]');
    expect(mentionOpt).not.toBeNull();
    act(() => {
      mentionOpt!.click();
    });
    expect(editorRec.text).toBe("Line 1 intro\nInspect @[docs/closing \\] bracket.md] ");

    // Trigger /slash on line 3 and select it via popup.
    act(() => {
      editorRec.setText(`${editorRec.text}\n/fi`);
    });
    const slashOpt = host.querySelector<HTMLButtonElement>('[data-testid="wb-composer-slash-option-fix"]');
    expect(slashOpt).not.toBeNull();
    act(() => {
      slashOpt!.click();
    });
    expect(selectedCommands).toEqual(["fix"]);
    expect(editorRec.text).toBe("Line 1 intro\nInspect @[docs/closing \\] bracket.md] \n/fix ");

    // Submit preserves multiline text and decodes the bracketed mention path cleanly.
    const surface = host.querySelector<HTMLDivElement>(".wb-composer-surface")!;
    act(() => {
      surface.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(submitted).toEqual([
      {
        text: "Line 1 intro\nInspect @[docs/closing \\] bracket.md] \n/fix",
        mentions: ["docs/closing ] bracket.md"],
      },
    ]);
  });

  it("caches inline replacement scans by (textSnapshot, knownPathsVersion) and distinguishes mentionItems=[] from undefined", () => {
    const host = mount(
      <MarkdownComposer
        defaultValue="Check @src/a.ts and @src/b.ts"
        mentionItems={[{ id: "a", path: "src/a.ts" }]}
      />,
    );
    const editorRec = fakeEditors[0]!;
    expect(editorRec.setProviderCalls).toBe(1);
    expect(editorRec.provider).not.toBeNull();

    // Wrap snapshot.readRange to count full-text scans.
    let readCalls = 0;
    const baseSnap = createStringTextSnapshot("Check @src/a.ts and @src/b.ts");
    const countedSnap = {
      ...baseSnap,
      readRange(start: number, end: number) {
        readCalls += 1;
        return baseSnap.readRange(start, end);
      },
    };

    const specs1 = editorRec.provider!({
      textSnapshot: countedSnap,
      languageId: "markdown",
      captures: [],
      selections: [],
    });
    expect(specs1).toHaveLength(1);
    expect(specs1[0]?.key).toContain("src/a.ts");
    expect(readCalls).toBe(1);

    // Repeated calls on the same snapshot (syntax captures / inline suggestion ticks) hit O(1) cache.
    const specs2 = editorRec.provider!({
      textSnapshot: countedSnap,
      languageId: "markdown",
      captures: [],
      selections: [],
    });
    expect(specs2).toBe(specs1);
    expect(readCalls).toBe(1);

    // Re-rendering with a fresh but set-equal mentionItems array neither re-registers nor invalidates cache.
    act(() => {
      activeRoot?.render(
        <MarkdownComposer
          defaultValue="Check @src/a.ts and @src/b.ts"
          mentionItems={[{ id: "a-copy", path: "src/a.ts" }]}
        />,
      );
    });
    expect(editorRec.setProviderCalls).toBe(1);
    const specs3 = editorRec.provider!({
      textSnapshot: countedSnap,
      languageId: "markdown",
      captures: [],
      selections: [],
    });
    expect(specs3).toBe(specs1);
    expect(readCalls).toBe(1);

    // Adding src/b.ts refreshes provider immediately and includes both chips.
    act(() => {
      activeRoot?.render(
        <MarkdownComposer
          defaultValue="Check @src/a.ts and @src/b.ts"
          mentionItems={[
            { id: "a", path: "src/a.ts" },
            { id: "b", path: "src/b.ts" },
          ]}
        />,
      );
    });
    const specsBoth = editorRec.provider!({
      textSnapshot: countedSnap,
      languageId: "markdown",
      captures: [],
      selections: [],
    });
    expect(specsBoth).toHaveLength(2);
    expect(readCalls).toBe(2);

    // Passing explicit empty mentionItems={[]} un-chips @src/a.ts instead of falling back to heuristic matching.
    act(() => {
      activeRoot?.render(<MarkdownComposer defaultValue="Check @src/a.ts and @src/b.ts" mentionItems={[]} />);
    });
    const specsEmpty = editorRec.provider!({
      textSnapshot: countedSnap,
      languageId: "markdown",
      captures: [],
      selections: [],
    });
    expect(specsEmpty).toHaveLength(0);

    // Passing mentionItems={undefined} restores heuristic matching for both paths.
    act(() => {
      activeRoot?.render(
        <MarkdownComposer defaultValue="Check @src/a.ts and @src/b.ts" mentionItems={undefined} />,
      );
    });
    const specsHeuristic = editorRec.provider!({
      textSnapshot: countedSnap,
      languageId: "markdown",
      captures: [],
      selections: [],
    });
    expect(specsHeuristic).toHaveLength(2);
    expect(host).not.toBeNull();
  });

  it("never calls materializeFullText during typing without onChange even when promptHistory is configured", () => {
    const host = mount(<MarkdownComposer defaultValue="" promptHistory={["previous prompt"]} />);
    const editorRec = fakeEditors[0]!;
    const surface = host.querySelector<HTMLDivElement>(".wb-composer-surface")!;

    act(() => {
      editorRec.setText("hello world");
      surface.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      surface.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(editorRec.materializeCalls).toBe(0);
  });
});
