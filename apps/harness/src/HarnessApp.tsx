import { useEffect, useRef, useState } from "react";
import {
  dismissSoftKeyboardOnTouchActivation,
  ensurePointerModalityTracking,
  resolveActivationFocus,
} from "@shaulavo/workbench-core";
import { useKeyboardInset, useWorkbenchTheme } from "@shaulavo/workbench-core/react";
import { observeWorkbenchTheme, readTerminalTokenColors } from "@shaulavo/workbench-tokens";

export interface HarnessAppProps {
  readonly hostKind: "plain" | "tailwind";
  readonly initialPreset: "sprockt" | "fregat";
  readonly initialMode: "light" | "dark";
}

const SAMPLE_TABS = [
  { id: "src/App.tsx", label: "App.tsx", tone: "ts" },
  { id: "src/styles.css", label: "styles.css", tone: "css" },
  { id: "package.json", label: "package.json", tone: "json" },
] as const;

function readRootTerminalBg(): string {
  const colors = readTerminalTokenColors(document.documentElement);
  return `rgb(${colors.background.r}, ${colors.background.g}, ${colors.background.b})`;
}

export function HarnessApp({ hostKind, initialPreset, initialMode }: HarnessAppProps) {
  const [preset, setPreset] = useState<"sprockt" | "fregat">(initialPreset);
  const [mode, setMode] = useState<"light" | "dark">(initialMode);
  const [density, setDensity] = useState<"default" | "compact">("default");
  const [scopedMode, setScopedMode] = useState<"light" | "dark">(initialMode === "light" ? "dark" : "light");
  const [activeTab, setActiveTab] = useState<string>(SAMPLE_TABS[0].id);
  const [lastDecision, setLastDecision] = useState<string>("none");
  const [termBg, setTermBg] = useState<string>(() => readRootTerminalBg());
  const [scopedNode, setScopedNode] = useState<HTMLElement | null>(null);

  const editorInputRef = useRef<HTMLTextAreaElement | null>(null);

  useKeyboardInset();
  const rootTheme = useWorkbenchTheme(document.documentElement);
  const scopedTheme = useWorkbenchTheme(scopedNode);

  useEffect(() => {
    ensurePointerModalityTracking();
    return observeWorkbenchTheme(document.documentElement, () => {
      setTermBg(readRootTerminalBg());
    });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.wbTheme = preset;
    root.dataset.theme = mode;
    root.classList.toggle("dark", mode === "dark");
    if (density === "compact") root.dataset.wbDensity = "compact";
    else delete root.dataset.wbDensity;
  }, [preset, mode, density]);

  function onTabActivate(tabId: string, event: React.MouseEvent<HTMLButtonElement>): void {
    const decision = resolveActivationFocus(event, "auto");
    setActiveTab(tabId);
    setLastDecision(`${decision.origin}:focus=${String(decision.shouldFocusEditor)}`);
    if (decision.shouldFocusEditor) {
      editorInputRef.current?.focus();
    } else {
      dismissSoftKeyboardOnTouchActivation(decision, event.currentTarget);
    }
  }

  return (
    <div className="harness-shell" data-testid="harness-ready" data-host-kind={hostKind}>
      <header className="harness-bar">
        <strong>Workbench Phase 0 ({hostKind})</strong>
        <button
          type="button"
          className="harness-btn"
          data-testid="preset-sprockt"
          data-active={preset === "sprockt"}
          onClick={() => setPreset("sprockt")}
        >
          Sprockt Sheet &amp; Biro
        </button>
        <button
          type="button"
          className="harness-btn"
          data-testid="preset-fregat"
          data-active={preset === "fregat"}
          onClick={() => setPreset("fregat")}
        >
          Fregat Graphite
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
      </header>

      <main className="harness-grid">
        <section className="harness-card">
          <h2>Root theme tokens</h2>
          <div className="harness-well" data-testid="root-theme-probe">
            <div>observedScheme: {rootTheme.scheme}</div>
            <div>terminalBg: {termBg}</div>
            <div>preset: {preset}</div>
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
          <div className="harness-tabs" role="tablist" aria-label="Sample files">
            {SAMPLE_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                className="harness-tab"
                data-tab-tone={tab.tone}
                data-testid={`sample-tab-${tab.id}`}
                aria-selected={activeTab === tab.id}
                onClick={(event) => onTabActivate(tab.id, event)}
              >
                {tab.label}
              </button>
            ))}
          </div>
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
      </main>
    </div>
  );
}
