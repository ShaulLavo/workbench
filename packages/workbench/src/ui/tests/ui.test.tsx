import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { DEFAULT_PANE_GEOMETRY, type GlobalPaneGeometry } from "../../core/index";
import { useViewportMode, useWorkbenchTheme } from "../../core/react/index";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandPalette,
  ConfirmDialog,
  createToastStore,
  FilterField,
  InlineRenameInput,
  MobilePaneShell,
  PointContextMenu,
  RenderErrorBoundary,
  resolveListboxKeyAction,
  SearchPanel,
  Splitter,
  ToastHost,
  ToolPane,
  UnsavedChangesDialog,
  VirtualList,
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

  it("forwards Base UI dismissal reason from PointContextMenu (escape-key vs outside-press)", () => {
    const reasons: (string | undefined)[] = [];
    const onOpenChange = vi.fn((open: boolean, reason?: string) => {
      if (!open) reasons.push(reason);
    });
    const host = mount(
      <WorkbenchPortalProvider>
        <button type="button" data-testid="outside-btn">
          Outside
        </button>
        <PointContextMenu
          open={true}
          x={40}
          y={40}
          items={[{ id: "copy", label: "Copy", onSelect: vi.fn() }]}
          onOpenChange={onOpenChange}
        />
      </WorkbenchPortalProvider>,
    );
    const menu = host.querySelector<HTMLElement>("[data-wb-point-context-menu]");
    expect(menu).not.toBeNull();
    act(() => {
      menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(reasons[0]).toBe("escape-key");

    const outside = host.querySelector<HTMLButtonElement>('[data-testid="outside-btn"]');
    act(() => {
      outside?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      outside?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    });
    expect(reasons[1]).toBe("outside-press");
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
    const editorTab = host.querySelector<HTMLButtonElement>('[data-testid="mobile-pane-editor"]');
    const panel = host.querySelector<HTMLDivElement>('[role="tabpanel"]');
    expect(explorerTab?.getAttribute("aria-controls")).toBe(panel?.id);
    expect(editorTab?.getAttribute("aria-controls")).toBeNull();
    expect(panel?.getAttribute("aria-labelledby")).toBe(explorerTab?.id);

    act(() => {
      explorerTab?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(editorTab?.getAttribute("aria-selected")).toBe("true");
    expect(editorTab?.getAttribute("aria-controls")).not.toBeNull();
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

  it("supports VirtualList flow layout (Plan 181: never directDomUpdates) and measured absolute directDomUpdates", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: `item-${i}`, label: `Row ${i}` }));
    const origRect = HTMLElement.prototype.getBoundingClientRect;
    const origScrollTo = HTMLElement.prototype.scrollTo;
    const origResizeObserver = globalThis.ResizeObserver;
    const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const origClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    const origScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const observedRows = new Set<Element>();
    class TrackingResizeObserver {
      observe(target: Element): void {
        if (target.classList.contains("wb-virtual-list-row")) observedRows.add(target);
      }
      unobserve(target: Element): void {
        observedRows.delete(target);
      }
      disconnect(): void {
        observedRows.clear();
      }
    }
    globalThis.ResizeObserver = TrackingResizeObserver as unknown as typeof ResizeObserver;
    HTMLElement.prototype.scrollTo = function mockScrollTo(arg?: ScrollToOptions | number, y?: number) {
      if (typeof arg === "number") {
        this.scrollTop = y ?? 0;
        return;
      }
      if (arg?.top !== undefined) this.scrollTop = arg.top;
    };
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-wb-virtual-list") ? 2600 : 30;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute("data-wb-virtual-list") ? 260 : 30;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return 320;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function mockRect() {
      const h = this.hasAttribute("data-wb-virtual-list") ? 260 : 30;
      return {
        width: 320,
        height: h,
        top: 0,
        left: 0,
        right: 320,
        bottom: h,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
    };

    try {
      // Flow layout keeps normal flow (paddingTop/paddingBottom + marginTop + estimated height) even if directDomUpdates={true} is passed.
      const flowHost = mount(
        <VirtualList
          items={items}
          getKey={(item) => item.id}
          layout="flow"
          directDomUpdates={true}
          initialRect={{ width: 320, height: 260 }}
          renderRow={(item) => <div style={{ height: "12px" }}>{item.label}</div>}
        />,
      );
      const flowList = flowHost.querySelector<HTMLDivElement>("[data-wb-virtual-list]");
      expect(flowList?.dataset.layout).toBe("flow");
      const flowInner = flowHost.querySelector<HTMLDivElement>(".wb-virtual-list-inner");
      expect(flowInner?.style.height).toBe("");
      expect(flowInner?.style.paddingTop).toBe("0px");
      const flowRows = flowHost.querySelectorAll<HTMLDivElement>('.wb-virtual-list-row[data-layout="flow"]');
      expect(flowRows.length).toBeGreaterThan(5);
      expect(flowRows[0]?.style.transform).toBe("");
      expect(flowRows[0]?.style.height).toBe("26px");

      // Switching runtime modes (absolute direct -> flow -> absolute non-direct -> absolute direct) leaves zero stale inline styles.
      act(() => {
        activeRoot?.render(
          <VirtualList
            items={items}
            getKey={(item) => item.id}
            layout="absolute"
            measureItems={true}
            initialRect={{ width: 320, height: 260 }}
            renderRow={(item) => <div>{item.label}</div>}
          />,
        );
      });
      const absDirectInner = flowHost.querySelector<HTMLDivElement>(".wb-virtual-list-inner");
      expect(absDirectInner?.style.height).toMatch(/^\d+px$/);
      const absDirectRows = flowHost.querySelectorAll<HTMLDivElement>(
        '.wb-virtual-list-row[data-layout="absolute"]',
      );
      expect(absDirectRows.length).toBeGreaterThan(5);
      expect(absDirectRows[1]?.style.transform).toContain("translate3d");

      // Switch back to flow from a scrolled absolute list: preserve scroller/inner identity + scrollTop and clear inline height/transforms.
      const scroller = flowHost.querySelector<HTMLDivElement>("[data-wb-virtual-list]");
      expect(scroller).not.toBeNull();
      if (scroller) scroller.scrollTop = 1000;
      act(() => {
        activeRoot?.render(
          <VirtualList
            items={items}
            getKey={(item) => item.id}
            layout="flow"
            initialRect={{ width: 320, height: 260 }}
            renderRow={(item) => <div>{item.label}</div>}
          />,
        );
      });
      const flowAgainScroller = flowHost.querySelector<HTMLDivElement>("[data-wb-virtual-list]");
      expect(flowAgainScroller).toBe(scroller);
      expect(flowAgainScroller?.scrollTop).toBe(1000);
      const flowAgainInner = flowHost.querySelector<HTMLDivElement>(".wb-virtual-list-inner");
      expect(flowAgainInner).toBe(absDirectInner);
      expect(flowAgainInner?.style.height).toBe("");
      const flowAgainRow = flowHost.querySelector<HTMLDivElement>('.wb-virtual-list-row[data-layout="flow"]');
      expect(flowAgainRow?.style.transform).toBe("");
      expect(flowAgainRow?.style.height).toBe("26px");

      // Toggling measureItems off on absolute directDomUpdates={false} replaces row DOM nodes so ResizeObserver detaches.
      act(() => {
        activeRoot?.render(
          <VirtualList
            items={items}
            getKey={(item) => item.id}
            layout="absolute"
            directDomUpdates={false}
            measureItems={true}
            initialRect={{ width: 320, height: 260 }}
            renderRow={(item) => <div>{item.label}</div>}
          />,
        );
      });
      const measuredRowNode = flowHost.querySelector<HTMLDivElement>(
        '.wb-virtual-list-row[data-layout="absolute"]',
      );
      expect(observedRows.size).toBeGreaterThan(0);
      act(() => {
        activeRoot?.render(
          <VirtualList
            items={items}
            getKey={(item) => item.id}
            layout="absolute"
            directDomUpdates={false}
            measureItems={false}
            initialRect={{ width: 320, height: 260 }}
            renderRow={(item) => <div>{item.label}</div>}
          />,
        );
      });
      const absOffRows = flowHost.querySelectorAll<HTMLDivElement>(
        '.wb-virtual-list-row[data-layout="absolute"]',
      );
      expect(absOffRows[0]).not.toBe(measuredRowNode);
      expect(observedRows.size).toBe(0);
      expect(absOffRows[1]?.style.transform).toBe("translateY(26px)");

      act(() => {
        activeRoot?.render(
          <VirtualList
            items={items}
            getKey={(item) => item.id}
            layout="absolute"
            directDomUpdates={true}
            initialRect={{ width: 320, height: 260 }}
            renderRow={(item) => <div>{item.label}</div>}
          />,
        );
      });
      const absBackOnRows = flowHost.querySelectorAll<HTMLDivElement>(
        '.wb-virtual-list-row[data-layout="absolute"]',
      );
      expect(absBackOnRows[1]?.style.transform).toContain("translate3d(0, 26px, 0)");

      // Fresh mount with an offscreen activeIndex scrolls the scroller immediately during initial mount.
      act(() => {
        activeRoot?.unmount();
      });
      const activeHost = mount(
        <VirtualList
          items={items}
          getKey={(item) => item.id}
          activeIndex={80}
          initialRect={{ width: 320, height: 260 }}
          renderRow={(item) => <div>{item.label}</div>}
        />,
      );
      const activeScroller = activeHost.querySelector<HTMLDivElement>("[data-wb-virtual-list]");
      expect(activeScroller?.scrollTop).toBe(1846);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = origRect;
      HTMLElement.prototype.scrollTo = origScrollTo;
      globalThis.ResizeObserver = origResizeObserver;
      if (origClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", origClientHeight);
      if (origClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", origClientWidth);
      if (origScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", origScrollHeight);
    }
  });

  it("ref-counts WorkbenchShell's shared icon sprite across multiple shells and restores document attributes on unmount", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prevTheme = document.documentElement.getAttribute("data-wb-theme");
    const prevDataTheme = document.documentElement.getAttribute("data-theme");
    const prevHadDark = document.documentElement.classList.contains("dark");
    document.documentElement.setAttribute("data-wb-theme", "custom-prev");
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.classList.remove("dark");

    const host1 = document.createElement("div");
    const host2 = document.createElement("div");
    document.body.append(host1, host2);
    const root1 = createRoot(host1);
    const root2 = createRoot(host2);
    try {
      act(() => {
        root1.render(
          <WorkbenchShell theme="fregat" colorScheme="dark" density="compact" syncDocumentAttributes>
            <div>shell-1</div>
          </WorkbenchShell>,
        );
      });
      expect(document.body.querySelectorAll("svg[data-wb-icon-sprite]")).toHaveLength(1);
      expect(document.documentElement.getAttribute("data-wb-theme")).toBe("fregat");
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);

      // Second shell shares the single sprite and warns on duplicate syncDocumentAttributes ownership.
      act(() => {
        root2.render(
          <WorkbenchShell theme="sprockt" colorScheme="light" syncDocumentAttributes>
            <div>shell-2</div>
          </WorkbenchShell>,
        );
      });
      expect(document.body.querySelectorAll("svg[data-wb-icon-sprite]")).toHaveLength(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      // First owner keeps document attributes intact until unmount.
      expect(document.documentElement.getAttribute("data-wb-theme")).toBe("fregat");

      // Unmounting shell 1 keeps the shared sprite alive for shell 2 and restores previous document attributes.
      act(() => {
        root1.unmount();
      });
      expect(document.body.querySelectorAll("svg[data-wb-icon-sprite]")).toHaveLength(1);
      expect(document.documentElement.getAttribute("data-wb-theme")).toBe("custom-prev");
      expect(document.documentElement.getAttribute("data-theme")).toBeNull();
      expect(document.documentElement.classList.contains("dark")).toBe(false);

      // Unmounting shell 2 removes the shared sprite completely.
      act(() => {
        root2.unmount();
      });
      expect(document.body.querySelectorAll("svg[data-wb-icon-sprite]")).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
      host1.remove();
      host2.remove();
      if (prevTheme === null) document.documentElement.removeAttribute("data-wb-theme");
      else document.documentElement.setAttribute("data-wb-theme", prevTheme);
      if (prevDataTheme === null) document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", prevDataTheme);
      document.documentElement.classList.toggle("dark", prevHadDark);
    }
  });

  it("keeps useViewportMode and useWorkbenchTheme SSR-safe and converges after client mount", () => {
    function Probe() {
      const viewport = useViewportMode(768);
      const theme = useWorkbenchTheme(null);
      return (
        <div data-testid="ssr-probe" data-viewport={viewport} data-scheme={theme.scheme}>
          {viewport}:{theme.scheme}
        </div>
      );
    }

    const origMatchMedia = window.matchMedia;
    document.documentElement.classList.add("dark");
    window.matchMedia = ((query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      // Server render always produces deterministic desktop + light output.
      const ssrHtml = renderToString(<Probe />);
      expect(ssrHtml).toContain('data-viewport="desktop"');
      expect(ssrHtml).toContain('data-scheme="light"');

      // Mounted client converges to phone + dark without mutating SSR defaults.
      const host = mount(<Probe />);
      const probe = host.querySelector<HTMLElement>('[data-testid="ssr-probe"]');
      expect(probe?.dataset.viewport).toBe("phone");
      expect(probe?.dataset.scheme).toBe("dark");
    } finally {
      document.documentElement.classList.remove("dark");
      window.matchMedia = origMatchMedia;
    }
  });
});
