import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_PANE_GEOMETRY,
  dismissSoftKeyboardOnTouchActivation,
  ensurePointerModalityTracking,
  type ActivationFocusDecision,
  type GlobalPaneGeometry,
  type LayoutAdapter,
  type WorkbenchCommand,
  type WorkbenchPaneId,
} from "@shaulavo/workbench-core";
import { useSubscribable, useWorkbenchTheme } from "@shaulavo/workbench-core/react";
import { MarkdownComposer } from "@shaulavo/workbench-editor/composer";
import { DiffEditorView } from "@shaulavo/workbench-editor/diff";
import { EditorGroupLayout } from "@shaulavo/workbench-editor/groups";
import { DiagnosticPeek, LspStatusBadge, type DiagnosticPeekModel } from "@shaulavo/workbench-editor/lsp";
import { FileIconSprite, FileTypeIcon, StrokeIcon } from "@shaulavo/workbench-icons/react";
import { PreviewPane } from "@shaulavo/workbench-preview";
import { TerminalPanel } from "@shaulavo/workbench-terminal";
import { observeWorkbenchTheme, readTerminalTokenColors } from "@shaulavo/workbench-tokens";
import { FileTreeView } from "@shaulavo/workbench-tree/react";
import {
  ActivityBar,
  BarTab,
  BarTabStrip,
  CommandPalette,
  ConfirmDialog,
  createToastStore,
  DesktopSplitGrid,
  Kbd,
  MobilePaneShell,
  PointContextMenu,
  SearchPanel,
  StatusBar,
  TitleBar,
  ToolPane,
  UnsavedChangesDialog,
  WorkbenchShell,
  type ContextMenuItem,
  type SearchMatch,
  type SearchQueryOptions,
} from "@shaulavo/workbench-ui";
import type { Terminal } from "ghostty-webgpu";
import { createHarnessEditorBundle } from "./editor-fixture";
import { createBridgedHarnessPreviewAdapter, createRemoteHarnessPreviewAdapter } from "./preview-fixture";
import { createHarnessTerminalBundle } from "./terminal-fixture";
import {
  create50kScaleTree,
  createDemoIndexedTree,
  createLazyDemoTree,
  type HarnessTreeBundle,
} from "./tree-fixture";

export interface HarnessAppProps {
  readonly hostKind: "plain" | "tailwind";
  readonly initialPreset: "sprockt" | "fregat";
  readonly initialMode: "light" | "dark";
}

const SAMPLE_FILES = [
  { id: "src/App.tsx", label: "App.tsx", tone: "ts" },
  { id: "src/styles.css", label: "styles.css", tone: "css" },
  { id: "package.json", label: "package.json", tone: "json" },
  { id: "CLAUDE.md", label: "CLAUDE.md", tone: "md" },
  { id: "src/App.test.tsx", label: "App.test.tsx", tone: "ts" },
] as const;

const SAMPLE_SEARCH_MATCHES: readonly SearchMatch[] = [
  {
    id: "m1",
    path: "src/App.tsx",
    line: 12,
    column: 7,
    preview: "export function App() { return <WorkbenchShell />; }",
    matchStart: 32,
    matchLength: 14,
  },
  {
    id: "m2",
    path: "CLAUDE.md",
    line: 3,
    column: 1,
    preview: "Use @shaulavo/workbench-ui and @shaulavo/workbench-icons.",
    matchStart: 4,
    matchLength: 26,
  },
];

function createInMemoryLayoutAdapter(): LayoutAdapter {
  let geometry: GlobalPaneGeometry = { ...DEFAULT_PANE_GEOMETRY };
  let mobileActivePane: WorkbenchPaneId = "editor";
  const geometryListeners = new Set<() => void>();
  const paneListeners = new Set<() => void>();

  return {
    geometry: {
      getSnapshot: () => geometry,
      subscribe(listener) {
        geometryListeners.add(listener);
        return () => {
          geometryListeners.delete(listener);
        };
      },
    },
    setGeometry(next) {
      geometry = next;
      for (const listener of geometryListeners) listener();
    },
    commitGeometry() {},
    mobileActivePane: {
      getSnapshot: () => mobileActivePane,
      subscribe(listener) {
        paneListeners.add(listener);
        return () => {
          paneListeners.delete(listener);
        };
      },
    },
    setMobileActivePane(pane) {
      mobileActivePane = pane;
      for (const listener of paneListeners) listener();
    },
  };
}

function readRootTerminalBg(): string {
  const colors = readTerminalTokenColors(document.documentElement);
  return `rgb(${colors.background.r}, ${colors.background.g}, ${colors.background.b})`;
}

function isPhoneViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(max-width: 768px)").matches;
}

export function HarnessApp({ hostKind, initialPreset, initialMode }: HarnessAppProps) {
  const [layout] = useState<LayoutAdapter>(() => createInMemoryLayoutAdapter());
  const [toastStore] = useState(() => createToastStore());
  const mobilePane = useSubscribable(layout.mobileActivePane);

  const [preset, setPreset] = useState<"sprockt" | "fregat">(initialPreset);
  const [mode, setMode] = useState<"light" | "dark">(initialMode);
  const [density, setDensity] = useState<"default" | "compact">("default");
  const [iconPreset, setIconPreset] = useState<"rich" | "stroke">("rich");
  const [scopedMode, setScopedMode] = useState<"light" | "dark">(initialMode === "light" ? "dark" : "light");
  const [phoneShell, setPhoneShell] = useState<boolean>(() => isPhoneViewport());
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const [activeTab, setActiveTab] = useState<string>(SAMPLE_FILES[0].id);
  const [sidebarView, setSidebarView] = useState<"explorer" | "search">("explorer");
  const [treeMode, setTreeMode] = useState<"25" | "50k" | "lazy">("25");
  const [treeBundle, setTreeBundle] = useState<HarnessTreeBundle>(() => createDemoIndexedTree());
  const [previewMode, setPreviewMode] = useState<"bridged" | "remote">("bridged");
  const [bridgedPreview] = useState(() => createBridgedHarnessPreviewAdapter());
  const [remotePreview] = useState(() => createRemoteHarnessPreviewAdapter());
  const [editorBundle] = useState(() => createHarnessEditorBundle());
  const [showDiff, setShowDiff] = useState(false);
  const [showDiagnosticPeek, setShowDiagnosticPeek] = useState(false);
  const [composerSubmitted, setComposerSubmitted] = useState("none");
  const [composerCommand, setComposerCommand] = useState("none");
  const [terminalTransparent, setTerminalTransparent] = useState(false);
  const [terminalBundle] = useState(() =>
    createHarnessTerminalBundle((path) => {
      setActiveTab(path);
    }),
  );
  const terminalStats = useSubscribable(terminalBundle.stats);
  const [ghosttyProbe, setGhosttyProbe] = useState<string>("pending");
  const activeGhosttyRef = useRef<Terminal | null>(null);
  const [searchQuery, setSearchQuery] = useState("workbench");
  const [searchOptions, setSearchOptions] = useState<SearchQueryOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });

  const [lastDecision, setLastDecision] = useState<string>("none");
  const [termBg, setTermBg] = useState<string>(() => readRootTerminalBg());
  const [scopedNode, setScopedNode] = useState<HTMLElement | null>(null);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unsavedOpen, setUnsavedOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    readonly open: boolean;
    readonly x: number;
    readonly y: number;
  }>({
    open: false,
    x: 120,
    y: 120,
  });

  const editorInputRef = useRef<HTMLTextAreaElement | null>(null);

  const rootTheme = useWorkbenchTheme(document.documentElement);
  const scopedTheme = useWorkbenchTheme(scopedNode);

  useEffect(() => {
    ensurePointerModalityTracking();
    const stopTheme = observeWorkbenchTheme(document.documentElement, () => {
      setTermBg(readRootTerminalBg());
    });
    const mq = window.matchMedia("(max-width: 768px)");
    const syncViewport = (): void => setPhoneShell(mq.matches);
    syncViewport();
    mq.addEventListener("change", syncViewport);
    return () => {
      stopTheme();
      mq.removeEventListener("change", syncViewport);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.wbTheme = preset;
    root.dataset.theme = mode;
    root.classList.toggle("dark", mode === "dark");
    if (density === "compact") root.dataset.wbDensity = "compact";
    else delete root.dataset.wbDensity;
  }, [preset, mode, density]);

  function onTabActivate(
    tabId: string,
    decision: ActivationFocusDecision,
    triggerEl?: HTMLElement | null,
  ): void {
    setActiveTab(tabId);
    setLastDecision(`${decision.origin}:focus=${String(decision.shouldFocusEditor)}`);
    if (decision.shouldFocusEditor) {
      editorInputRef.current?.focus();
    } else {
      dismissSoftKeyboardOnTouchActivation(decision, triggerEl ?? null);
    }
  }

  const commands: readonly WorkbenchCommand[] = [
    {
      id: "theme.toggle",
      label: "Toggle color scheme",
      category: "View",
      run() {
        setMode((m) => (m === "light" ? "dark" : "light"));
        toastStore.push({ id: "theme-switched", tone: "info", title: "Color scheme updated" });
      },
    },
    {
      id: "toast.demo",
      label: "Show saved notification",
      category: "File",
      run() {
        toastStore.push({
          id: "saved-toast",
          tone: "success",
          title: "Saved workspace changes",
          description: activeTab,
        });
      },
    },
    {
      id: "dialog.confirm",
      label: "Open delete confirmation",
      category: "File",
      run() {
        setConfirmOpen(true);
      },
    },
  ];

  const menuItems: readonly ContextMenuItem[] = [
    {
      id: "rename",
      label: "Rename file",
      hint: "F2",
      testId: "ctx-rename",
      onSelect() {
        treeBundle.model.setDraft({ mode: "rename", path: activeTab });
      },
    },
    {
      id: "delete",
      label: "Delete file",
      hint: "⌫",
      danger: true,
      separatorBefore: true,
      testId: "ctx-delete",
      onSelect() {
        setConfirmOpen(true);
      },
    },
  ];

  function selectTreeMode(next: "25" | "50k" | "lazy"): void {
    setTreeMode(next);
    if (next === "50k") setTreeBundle(create50kScaleTree());
    else if (next === "lazy") setTreeBundle(createLazyDemoTree());
    else setTreeBundle(createDemoIndexedTree());
  }

  const filteredMatches = SAMPLE_SEARCH_MATCHES.filter((match) =>
    !searchQuery.trim()
      ? true
      : match.preview.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()),
  );

  const explorerPane =
    sidebarView === "search" ? (
      <SearchPanel
        query={searchQuery}
        onQueryChange={setSearchQuery}
        options={searchOptions}
        onOptionsChange={setSearchOptions}
        matches={filteredMatches}
        iconPreset={iconPreset}
        onSelectMatch={(match, decision) => {
          onTabActivate(match.path, decision);
          if (phoneShell) layout.setMobileActivePane("editor");
        }}
      />
    ) : (
      <ToolPane
        title="Explorer"
        scroll={false}
        actions={
          <div className="harness-toolbar-group">
            <button
              type="button"
              className="harness-btn"
              data-testid="tree-mode-25"
              data-active={treeMode === "25"}
              onClick={() => selectTreeMode("25")}
            >
              25
            </button>
            <button
              type="button"
              className="harness-btn"
              data-testid="tree-mode-50k"
              data-active={treeMode === "50k"}
              onClick={() => selectTreeMode("50k")}
            >
              50k
            </button>
            <button
              type="button"
              className="harness-btn"
              data-testid="tree-mode-lazy"
              data-active={treeMode === "lazy"}
              onClick={() => selectTreeMode("lazy")}
            >
              Lazy
            </button>
          </div>
        }
      >
        <FileTreeView
          key={treeMode}
          model={treeBundle.model}
          adapter={treeBundle.adapter}
          iconPreset={iconPreset}
          onOpenFile={(path, decision) => {
            onTabActivate(path, decision);
            if (phoneShell) layout.setMobileActivePane("editor");
          }}
          onError={(message) => {
            toastStore.push({ id: "tree-error", tone: "error", title: message });
          }}
        />
      </ToolPane>
    );

  const editorPane = (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <BarTabStrip label="Sample files">
        {SAMPLE_FILES.slice(0, 4).map((tab) => (
          <BarTab
            key={tab.id}
            active={activeTab === tab.id}
            label={tab.label}
            tone={tab.tone}
            icon={<FileTypeIcon entry={{ name: tab.id, type: "file" }} preset={iconPreset} sprite />}
            data-testid={`sample-tab-${tab.id}`}
            onActivate={(decision, event) => onTabActivate(tab.id, decision, event.currentTarget)}
          />
        ))}
      </BarTabStrip>

      <div className="harness-editor-body">
        <div className="harness-toolbar-group">
          <button
            type="button"
            className="wb-button"
            data-testid="open-palette"
            onClick={() => setPaletteOpen(true)}
          >
            Command palette <Kbd>⌘K</Kbd>
          </button>
          <button
            type="button"
            className="wb-button"
            data-testid="open-confirm"
            onClick={() => setConfirmOpen(true)}
          >
            Confirm dialog
          </button>
          <button
            type="button"
            className="wb-button"
            data-testid="open-unsaved"
            onClick={() => setUnsavedOpen(true)}
          >
            Unsaved dialog
          </button>
          <button
            type="button"
            className="wb-button"
            data-testid="open-context-menu"
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setContextMenu({ open: true, x: Math.round(rect.left), y: Math.round(rect.bottom + 4) });
            }}
          >
            Context menu
          </button>
          <button
            type="button"
            className="wb-button"
            data-testid="toggle-icon-preset"
            onClick={() => setIconPreset((p) => (p === "rich" ? "stroke" : "rich"))}
          >
            Icons: {iconPreset}
          </button>
          <button
            type="button"
            className="wb-button"
            data-testid="simulate-keyboard"
            onClick={() => setKeyboardOpen((open) => !open)}
          >
            Soft keyboard: {keyboardOpen ? "open" : "closed"}
          </button>
          <button
            type="button"
            className="wb-button"
            data-testid="toggle-terminal-override"
            onClick={() => setTerminalTransparent((v) => !v)}
          >
            Term override: {terminalTransparent ? "transparent" : "css"}
          </button>
          <button
            type="button"
            className="wb-button"
            data-testid="enable-decckm"
            onClick={() => {
              const id = terminalBundle.adapter.activeId.getSnapshot();
              if (id) terminalBundle.enableDecckm(id);
            }}
          >
            Enable DECCKM
          </button>
          <button
            type="button"
            className="wb-button"
            data-testid="editor-split-right"
            onClick={() => editorBundle.splitActiveRight()}
          >
            Split editor
          </button>
          <button
            type="button"
            className="wb-button"
            data-testid="editor-toggle-peek"
            onClick={() => setShowDiagnosticPeek((v) => !v)}
          >
            Diagnostic peek
          </button>
          <button
            type="button"
            className="wb-button"
            data-testid="editor-trigger-conflict"
            onClick={() => editorBundle.triggerConflict("src/App.tsx")}
          >
            Trigger conflict
          </button>
          <button
            type="button"
            className="wb-button"
            data-testid="editor-open-large"
            onClick={() => editorBundle.openLargeFile()}
          >
            Open &gt;2MiB file
          </button>
          <button
            type="button"
            className="wb-button"
            data-testid="editor-toggle-diff"
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? "Show editor" : "Show diff"}
          </button>
        </div>

        <div className="harness-singapore-stage">
          {showDiff ? (
            <DiffEditorView
              path="src/App.tsx"
              mode="split"
              originalText={'export function App() {\n  return "Old";\n}\n'}
              modifiedText={'export function App() {\n  return "Shared Workbench Ready";\n}\n'}
            />
          ) : (
            <EditorGroupLayout
              documents={editorBundle.documents}
              groups={editorBundle.groups}
              iconPreset={iconPreset}
              renderGroupOverlay={(group) => {
                if (!showDiagnosticPeek || group.id !== "main") return null;
                const peekModel: DiagnosticPeekModel = {
                  severity: "error",
                  message: "Type 'string' is not assignable to type 'number'.",
                  source: "ts",
                  code: "2322",
                  geometry: {
                    kind: "visible",
                    anchorRect: { top: 48, bottom: 68, left: 24, right: 120, width: 96, height: 20 },
                    clipRect: { top: 0, bottom: 220, left: 0, right: 640, width: 640, height: 220 },
                  },
                  relatedInformation: [
                    {
                      label: "Expected number here",
                      target: { path: "src/styles.css", line: 1, column: 1 },
                    },
                  ],
                };
                return (
                  <DiagnosticPeek
                    model={peekModel}
                    onClose={() => setShowDiagnosticPeek(false)}
                    onOpenTarget={(target) => {
                      editorBundle.lsp.openLocation(target, {
                        shouldFocusEditor: true,
                        origin: "mouse",
                      });
                    }}
                  />
                );
              }}
            />
          )}
        </div>

        <div className="harness-composer-card">
          <MarkdownComposer
            ariaLabel="Message"
            mentionItems={editorBundle.mentionItems}
            slashCommands={editorBundle.slashCommands}
            onSelectCommand={(cmd) => setComposerCommand(cmd.name)}
            onSubmit={(payload) => setComposerSubmitted(`${payload.text} [${payload.mentions.join(",")}]`)}
          />
          <div className="harness-well">
            <span data-testid="composer-submit-probe">submitted: {composerSubmitted}</span> ·{" "}
            <span data-testid="composer-command-probe">command: {composerCommand}</span>
          </div>
        </div>

        <div className="harness-grid">
          <section className="harness-card">
            <h2>Root theme tokens</h2>
            <div className="harness-well" data-testid="root-theme-probe">
              <div>observedScheme: {rootTheme.scheme}</div>
              <div>terminalBg: {termBg}</div>
              <div>preset: {preset}</div>
              <div data-testid="terminal-appearance-probe">ghostty: {ghosttyProbe}</div>
              <div data-testid="terminal-stats-probe">
                lastInput: {terminalStats.lastInput || "none"} · detaches: {terminalStats.detachCount} ·
                closes: {terminalStats.closeCount}
              </div>
            </div>
            {hostKind === "tailwind" ? (
              <div style={{ color: "rgb(255, 0, 255)" }}>
                <div
                  className="rounded border border-wb-border bg-wb-well p-2 text-xs text-wb-fg"
                  data-testid="tailwind-bridge-probe"
                >
                  Tailwind @theme inline bridge active
                </div>
              </div>
            ) : null}
          </section>

          <section
            ref={setScopedNode}
            className="harness-card"
            data-wb-theme-scope=""
            data-wb-theme={preset}
            data-theme={scopedMode}
            data-testid="scoped-theme-card"
          >
            <h2>Scoped embedded theme</h2>
            <button
              type="button"
              className="harness-btn"
              data-testid="toggle-scoped-mode"
              onClick={() => setScopedMode((m) => (m === "light" ? "dark" : "light"))}
            >
              Scoped mode: {scopedMode}
            </button>
            <div className="harness-well" data-testid="scoped-theme-probe">
              scopedObserved: {scopedTheme.scheme} (rev {scopedTheme.revision})
            </div>
          </section>

          <section className="harness-card">
            <h2>Per-activation touch focus policy</h2>
            <div data-testid="focus-decision">{lastDecision}</div>
            <textarea
              ref={editorInputRef}
              className="harness-editor-input"
              aria-label="Mock editor input"
              data-testid="mock-editor-input"
              value={`// Active file: ${activeTab}\nexport const ok = true;\n`}
              readOnly
            />
          </section>
        </div>
      </div>
    </div>
  );

  const previewPane = (
    <PreviewPane
      key={previewMode}
      adapter={previewMode === "bridged" ? bridgedPreview : remotePreview}
      actions={
        <button
          type="button"
          className="harness-btn"
          data-testid="toggle-preview-mode"
          onClick={() => setPreviewMode((m) => (m === "bridged" ? "remote" : "bridged"))}
        >
          {previewMode === "bridged" ? "Bridged" : "Remote"}
        </button>
      }
    />
  );

  function syncGhosttyProbe(term: Terminal): void {
    const app = term.appearance;
    const bg = app.theme.background;
    const selFg = app.theme.selectionForeground;
    const ansi1 = app.theme.palette[1];
    setGhosttyProbe(
      `scheme=${app.colorScheme} opacity=${app.backgroundOpacity} bg=${bg.r},${bg.g},${bg.b} selFg=${selFg.r},${selFg.g},${selFg.b} ansi1=${ansi1?.r ?? 0},${ansi1?.g ?? 0},${ansi1?.b ?? 0} font=${app.font.size}`,
    );
  }

  const terminalPane = (
    <TerminalPanel
      adapter={terminalBundle.adapter}
      active={!phoneShell || mobilePane === "terminal"}
      themeOverride={terminalTransparent ? terminalBundle.transparentOverride : undefined}
      showAccessoryBar
      onTerminalReady={(_id, term) => {
        activeGhosttyRef.current = term;
        syncGhosttyProbe(term);
        term.on("appearance", () => {
          if (activeGhosttyRef.current === term) syncGhosttyProbe(term);
        });
      }}
    />
  );

  return (
    <WorkbenchShell
      theme={preset}
      colorScheme={mode}
      density={density}
      shell={phoneShell ? "phone" : "desktop"}
      toastStore={toastStore}
      onKeyboardInsetChange={({ open }) => setKeyboardOpen(open)}
      className="harness-root"
      data-testid="harness-ready"
      data-host-kind={hostKind}
      titleBar={
        <TitleBar
          leading={<strong>Workbench ({hostKind})</strong>}
          trailing={
            <div className="harness-toolbar-group">
              <button
                type="button"
                className="harness-btn"
                data-testid="preset-sprockt"
                data-active={preset === "sprockt"}
                onClick={() => setPreset("sprockt")}
              >
                Sprockt
              </button>
              <button
                type="button"
                className="harness-btn"
                data-testid="preset-fregat"
                data-active={preset === "fregat"}
                onClick={() => setPreset("fregat")}
              >
                Fregat
              </button>
              <button
                type="button"
                className="harness-btn"
                data-testid="toggle-mode"
                onClick={() => setMode((m) => (m === "light" ? "dark" : "light"))}
              >
                Mode: {mode}
              </button>
              <button
                type="button"
                className="harness-btn"
                data-testid="toggle-density"
                onClick={() => setDensity((d) => (d === "default" ? "compact" : "default"))}
              >
                Density: {density}
              </button>
            </div>
          }
        />
      }
      activityBar={
        phoneShell ? undefined : (
          <ActivityBar
            items={[
              {
                id: "explorer",
                label: "Explorer",
                shortcutHint: "⌘B",
                icon: <StrokeIcon name="folder" />,
                active: sidebarView === "explorer",
                onSelect: () => setSidebarView("explorer"),
              },
              {
                id: "search",
                label: "Search",
                shortcutHint: "⇧⌘F",
                icon: <StrokeIcon name="search" />,
                active: sidebarView === "search",
                badge: filteredMatches.length,
                onSelect: () => setSidebarView("search"),
              },
            ]}
          />
        )
      }
      statusBar={
        <StatusBar
          leading={<span>{activeTab}</span>}
          trailing={
            <>
              <LspStatusBadge adapter={editorBundle.lsp} />
              <span>{preset}</span>
              <span>{mode}</span>
            </>
          }
        />
      }
      overlays={
        <>
          <FileIconSprite preset="rich" />
          <FileIconSprite preset="stroke" />
          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            commands={commands}
            hotkeys={{ formatHint: (id) => (id === "theme.toggle" ? "⌘⇧T" : undefined) }}
          />
          <ConfirmDialog
            open={confirmOpen}
            title="Delete file?"
            description={`Permanently delete ${activeTab}?`}
            confirmLabel="Delete"
            danger
            onConfirm={() => {
              setConfirmOpen(false);
              toastStore.push({ id: "deleted", tone: "warning", title: `Deleted ${activeTab}` });
            }}
            onCancel={() => setConfirmOpen(false)}
          />
          <UnsavedChangesDialog
            open={unsavedOpen}
            files={[activeTab]}
            onSave={() => {
              setUnsavedOpen(false);
              toastStore.push({ id: "saved-close", tone: "success", title: `Saved ${activeTab}` });
            }}
            onDiscard={() => setUnsavedOpen(false)}
            onCancel={() => setUnsavedOpen(false)}
          />
          <PointContextMenu
            open={contextMenu.open}
            x={contextMenu.x}
            y={contextMenu.y}
            items={menuItems}
            onOpenChange={(open) => setContextMenu((prev) => ({ ...prev, open }))}
          />
        </>
      }
    >
      {phoneShell ? (
        <MobilePaneShell
          activePane={mobilePane}
          onSelectPane={(pane) => layout.setMobileActivePane(pane)}
          keyboardOpen={keyboardOpen}
          panes={[
            { id: "explorer", label: "Files", icon: <StrokeIcon name="folder" />, content: explorerPane },
            { id: "editor", label: "Editor", icon: <StrokeIcon name="file" />, content: editorPane },
            { id: "preview", label: "Preview", icon: <StrokeIcon name="preview" />, content: previewPane },
            {
              id: "terminal",
              label: "Terminal",
              icon: <StrokeIcon name="terminal" />,
              content: terminalPane,
              keepMounted: true,
            },
          ]}
        />
      ) : (
        <DesktopSplitGrid
          layout={layout}
          explorer={explorerPane}
          editor={editorPane}
          preview={previewPane}
          terminal={terminalPane}
        />
      )}
    </WorkbenchShell>
  );
}
