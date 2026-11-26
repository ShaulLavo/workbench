import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_PANE_GEOMETRY, type GlobalPaneGeometry } from "@shaulavo/workbench-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandPalette,
  ConfirmDialog,
  createToastStore,
  FilterField,
  InlineRenameInput,
  MobilePaneShell,
  RenderErrorBoundary,
  resolveListboxKeyAction,
  SearchPanel,
  Splitter,
  ToastHost,
  ToolPane,
  UnsavedChangesDialog,
  WorkbenchPortalProvider,
  WorkbenchShell,
} from "../index";

let activeRoot: Root | null = null;
let activeHost: HTMLDivElement | null = null;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

describe("@shaulavo/workbench-ui", () => {
  it("mounts Base UI dialogs inside the scoped WorkbenchPortalProvider root", () => {
    const host = mount(
      <WorkbenchShell theme="sprockt" colorScheme="dark" density="compact">
        <ConfirmDialog
          open
          title="Delete file?"
          description="This removes src/index.ts permanently."
          danger
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      </WorkbenchShell>,
    );

    const scope = host.querySelector("[data-wb-theme-scope]");
    const portalRoot = scope?.querySelector("[data-wb-portal-root]");
    const dialog = portalRoot?.querySelector('[data-testid="wb-confirm-dialog"]');
    expect(scope?.getAttribute("data-wb-theme")).toBe("sprockt");
    expect(scope?.getAttribute("data-wb-density")).toBe("compact");
    expect(dialog).not.toBeNull();
  });

  it("handles UnsavedChangesDialog save, discard, cancel, and busy lock", () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    const onCancel = vi.fn();

    const host = mount(
      <WorkbenchPortalProvider>
        <UnsavedChangesDialog
          open
          files={["src/App.tsx"]}
          onSave={onSave}
          onDiscard={onDiscard}
          onCancel={onCancel}
        />
      </WorkbenchPortalProvider>,
    );

    expect(host.textContent).toContain("Save changes to src/App.tsx?");
    const discardBtn = host.querySelector<HTMLButtonElement>('[data-testid="wb-unsaved-discard"]');
    const saveBtn = host.querySelector<HTMLButtonElement>('[data-testid="wb-unsaved-save"]');
    act(() => {
      discardBtn?.click();
      saveBtn?.click();
    });
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("filters CommandPalette items and runs the selected item on Enter", () => {
    const ran: string[] = [];
    const onOpenChange = vi.fn();
    const host = mount(
      <WorkbenchPortalProvider>
        <CommandPalette
          open
          onOpenChange={onOpenChange}
          items={[
            { id: "open", label: "Open File", hint: "⌘P", onSelect: () => ran.push("open") },
            { id: "term", label: "Toggle Terminal", hint: "⌃`", onSelect: () => ran.push("term") },
          ]}
        />
      </WorkbenchPortalProvider>,
    );

    const input = host.querySelector<HTMLInputElement>('[data-testid="wb-command-palette-input"]');
    expect(input).not.toBeNull();
    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(ran).toEqual(["term"]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("re-evaluates mutable command enabled() predicates across reopen and at dispatch", () => {
    let canRun = true;
    const ran: string[] = [];
    const stableCommands = [
      {
        id: "save",
        label: "Save File",
        enabled: () => canRun,
        run: () => {
          ran.push("save");
        },
      },
    ];

    function Harness({ open }: { readonly open: boolean }) {
      return (
        <WorkbenchPortalProvider>
          <CommandPalette open={open} onOpenChange={vi.fn()} commands={stableCommands} />
        </WorkbenchPortalProvider>
      );
    }

    const host = mount(<Harness open />);
    const input = host.querySelector<HTMLInputElement>('[data-testid="wb-command-palette-input"]');
    expect(host.querySelector('[data-testid="wb-palette-item-save"]')).not.toBeNull();

    // Predicate flips to false while still open -> Enter must NOT execute stale enabled command.
    canRun = false;
    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(ran).toEqual([]);

    // Reopening with the same referentially stable `commands` array hides the disabled command.
    act(() => {
      activeRoot?.render(<Harness open={false} />);
    });
    act(() => {
      activeRoot?.render(<Harness open />);
    });
    expect(host.querySelector('[data-testid="wb-palette-item-save"]')).toBeNull();
  });

  it("handles FilterField Escape clear, ArrowDown handoff, and IME guard", () => {
    const onArrowDown = vi.fn();
    function Harness() {
      const [val, setVal] = useState("abc");
      return <FilterField aria-label="Filter" value={val} onValueChange={setVal} onArrowDown={onArrowDown} />;
    }

    const host = mount(<Harness />);
    const input = host.querySelector<HTMLInputElement>("input");
    expect(input?.value).toBe("abc");

    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(onArrowDown).toHaveBeenCalledTimes(1);

    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(input?.value).toBe("");
  });

  it("commits InlineRenameInput once on Enter and blocks commit while invalid", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();

    const host = mount(
      <InlineRenameInput
        initialValue="app.tsx"
        initialSelection={[0, 3]}
        validationMessage="Name already exists"
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );
    const input = host.querySelector<HTMLInputElement>("input");
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCommit).not.toHaveBeenCalled();

    act(() => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("resizes and toggles panes via Splitter keyboard controls", () => {
    const committed: GlobalPaneGeometry[] = [];
    const host = mount(
      <Splitter
        splitter="explorer"
        label="Resize explorer"
        controls="explorer-pane"
        geometry={DEFAULT_PANE_GEOMETRY}
        valueNow={20}
        measureSpace={() => ({ width: 1200, height: 800 })}
        measurePaneSize={() => 240}
        onPreviewGeometry={vi.fn()}
        onCommitGeometry={(next) => committed.push(next)}
      />,
    );

    const handle = host.querySelector<HTMLDivElement>('[role="separator"]');
    act(() => {
      handle?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      handle?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(committed[0]?.explorerWidthPx).toBe(264);
    expect(committed[1]?.explorerOpen).toBe(false);
  });

  it("hides MobilePaneShell switcher while keyboardOpen is true", () => {
    const onSelectPane = vi.fn();
    const host = mount(
      <MobilePaneShell
        activePane="editor"
        onSelectPane={onSelectPane}
        keyboardOpen
        panes={[
          { id: "explorer", label: "Files", content: <div>files</div> },
          { id: "editor", label: "Code", content: <div>code</div> },
        ]}
      />,
    );

    const switcher = host.querySelector<HTMLElement>("[data-wb-pane-switcher]");
    expect(switcher?.hidden).toBe(true);
  });

  it("wires ARIA tablist controls and arrow-key navigation in MobilePaneShell", () => {
    function Harness() {
      const [pane, setPane] = useState<"explorer" | "editor" | "terminal">("explorer");
      return (
        <MobilePaneShell
          activePane={pane}
          onSelectPane={(next) => setPane(next as "explorer" | "editor" | "terminal")}
          panes={[
            { id: "explorer", label: "Files", content: <div>files</div> },
            { id: "editor", label: "Code", content: <div>code</div> },
            { id: "terminal", label: "Terminal", content: <div>term</div> },
          ]}
        />
      );
    }

    const host = mount(<Harness />);
    const explorerTab = host.querySelector<HTMLButtonElement>('[data-testid="mobile-pane-explorer"]');
    const panel = host.querySelector<HTMLDivElement>('[role="tabpanel"]');
    expect(explorerTab?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(panel?.getAttribute("aria-labelledby")).toBe(explorerTab?.id);

    act(() => {
      explorerTab?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    const editorTab = host.querySelector<HTMLButtonElement>('[data-testid="mobile-pane-editor"]');
    expect(editorTab?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(editorTab);
  });

  it("moves focus from SearchPanel filter input into the first match on ArrowDown", () => {
    const heightSpy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
    const widthSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(320);
    try {
      const host = mount(
        <SearchPanel
          query="app"
          onQueryChange={vi.fn()}
          matches={[
            { id: "m1", path: "src/App.tsx", line: 1, column: 1, preview: "export function App() {}" },
          ]}
          onSelectMatch={vi.fn()}
        />,
      );
      const input = host.querySelector<HTMLInputElement>('input[aria-label="Search query"]');
      const firstMatch = host.querySelector<HTMLButtonElement>('[data-testid="wb-search-match-m1"]');
      expect(input).not.toBeNull();
      expect(firstMatch).not.toBeNull();

      act(() => {
        input?.focus();
        input?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      expect(document.activeElement).toBe(firstMatch);
    } finally {
      heightSpy.mockRestore();
      widthSpy.mockRestore();
    }
  });

  it("prioritizes ToolPane pending over empty and isolates RenderErrorBoundary failures", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Boom(): never {
      throw new Error("boom");
    }

    const host = mount(
      <div>
        <ToolPane title="Files" state={{ pending: true, empty: true }}>
          <div>loaded</div>
        </ToolPane>
        <RenderErrorBoundary label="Editor">
          <Boom />
        </RenderErrorBoundary>
      </div>,
    );

    expect(host.textContent).toContain("Loading Files");
    expect(host.textContent).not.toContain("No items");
    expect(host.textContent).toContain("Editor encountered a rendering error");
    spy.mockRestore();
  });

  it("pushes, deduplicates, and dismisses toasts inside the scoped portal", () => {
    const store = createToastStore();
    const host = mount(
      <WorkbenchPortalProvider>
        <ToastHost store={store} />
      </WorkbenchPortalProvider>,
    );

    act(() => {
      store.push({ id: "saved", tone: "success", title: "Saved", durationMs: 0 });
    });
    expect(host.querySelector('[data-testid="wb-toast-saved"]')).not.toBeNull();

    act(() => {
      store.dismiss("saved");
    });
    expect(host.querySelector('[data-testid="wb-toast-saved"]')).toBeNull();
  });

  it("resolves listbox navigation keys predictably", () => {
    expect(resolveListboxKeyAction({ key: "ArrowDown", count: 3, activeIndex: 2 })).toEqual({
      kind: "move",
      index: 0,
    });
    expect(resolveListboxKeyAction({ key: "ArrowUp", count: 3, activeIndex: 0 })).toEqual({
      kind: "move",
      index: 2,
    });
    expect(resolveListboxKeyAction({ key: "Enter", count: 3, activeIndex: 1 })).toEqual({
      kind: "commit",
    });
  });
});
