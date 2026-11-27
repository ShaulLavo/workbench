import { spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, webkit, type Browser } from "playwright";

export interface PackedBrowserCheckDirs {
  readonly minReactDir: string;
  readonly iconsOnlyDir: string;
  readonly bareEditorDir: string;
  readonly fullPeerDir: string;
}

interface BuiltSite {
  readonly name: string;
  readonly distDir: string;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
};

function runCmd(cmd: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${cmd} ${args.join(" ")} in ${cwd}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function buildVitePage(
  fixtureDir: string,
  pageName: string,
  files: Readonly<Record<string, string>>,
  options?: { readonly useTailwind?: boolean; readonly ssrHtml?: string; readonly htmlAttrs?: string },
): BuiltSite {
  const appDir = path.join(fixtureDir, "apps", pageName);
  const outDir = path.join(fixtureDir, "built", pageName);
  mkdirSync(appDir, { recursive: true });
  const htmlAttrs = options?.htmlAttrs ?? "";
  const ssrHtml = options?.ssrHtml ?? "";
  writeFileSync(
    path.join(appDir, "index.html"),
    `<!doctype html><html${htmlAttrs ? ` ${htmlAttrs}` : ""}><head><meta charset="utf-8" /></head><body><div id="root">${ssrHtml}</div><script type="module" src="/main.tsx"></script></body></html>\n`,
  );
  for (const [relPath, content] of Object.entries(files)) {
    const target = path.join(appDir, relPath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  const viteConfigPath = path.join(appDir, "vite.config.ts");
  const pluginsCode = options?.useTailwind
    ? 'import tailwindcss from "@tailwindcss/vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ root: __dirname, base: `./`, plugins: [tailwindcss(), react()], build: { outDir, emptyOutDir: true, target: "esnext" } });\n'
    : 'import react from "@vitejs/plugin-react";\nexport default defineConfig({ root: __dirname, base: `./`, plugins: [react()], build: { outDir, emptyOutDir: true, target: "esnext" } });\n';
  writeFileSync(
    viteConfigPath,
    `import { fileURLToPath } from "node:url";\nimport path from "node:path";\nimport { defineConfig } from "vite";\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nconst outDir = ${JSON.stringify(outDir)};\n${pluginsCode}`,
  );
  runCmd("bunx", ["vite", "build", "--config", viteConfigPath], fixtureDir);
  return { name: pageName, distDir: outDir };
}

function startStaticServer(
  sites: readonly BuiltSite[],
): Promise<{ readonly server: Server; readonly baseUrl: string }> {
  const siteMap = new Map(sites.map((site) => [site.name, site.distDir] as const));
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      const segments = reqUrl.pathname.split("/").filter(Boolean);
      const siteName = segments[0];
      const distDir = siteName ? siteMap.get(siteName) : undefined;
      if (!distDir) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const rel = segments.slice(1).join("/") || "index.html";
      const filePath = path.resolve(distDir, rel);
      if (!filePath.startsWith(distDir) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath);
      res.setHeader("Content-Type", MIME_TYPES[ext] ?? "application/octet-stream");
      res.end(readFileSync(filePath));
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to bind pack-check static server"));
        return;
      }
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function assertCssAssetUniqueness(distDir: string): void {
  const cssFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".css")) cssFiles.push(full);
    }
  };
  walk(distDir);
  if (cssFiles.length === 0) {
    throw new Error(`Tailwind fixture produced zero .css assets in ${distDir}`);
  }
  const combined = cssFiles.map((file) => readFileSync(file, "utf8")).join("\n");
  const synStringMatches = combined.match(/--wb-syn-string\s*:/g) ?? [];
  if (synStringMatches.length !== 1) {
    throw new Error(
      `Expected --wb-syn-string declaration once across emitted CSS assets, found ${synStringMatches.length} (${cssFiles.map((f) => path.basename(f)).join(", ")})`,
    );
  }
  const uiPaletteMatches = combined.match(/\.wb-palette-popup\s*\{/g) ?? [];
  if (uiPaletteMatches.length !== 1) {
    throw new Error(
      `Expected .wb-palette-popup (ui.css) rule once across emitted CSS assets, found ${uiPaletteMatches.length}`,
    );
  }
}

function buildAllSites(dirs: PackedBrowserCheckDirs): readonly BuiltSite[] {
  const sites: BuiltSite[] = [];

  // 1. Root `.` (named imports, zero manual CSS imports)
  sites.push(
    buildVitePage(dirs.minReactDir, "entry-root", {
      "main.tsx": `
import { createRoot } from "react-dom/client";
import { InlineRenameInput, TitleBar, WorkbenchShell } from "@shaulavo/workbench";
createRoot(document.getElementById("root")!).render(
  <WorkbenchShell colorScheme="dark" titleBar={<TitleBar leading={<span>Root</span>} />}>
    <InlineRenameInput initialValue="demo.ts" onCommit={() => {}} onCancel={() => {}} />
  </WorkbenchShell>,
);
`,
    }),
  );

  // 2. `./icons` (zero @base-ui/react, named imports, zero manual CSS imports)
  sites.push(
    buildVitePage(dirs.iconsOnlyDir, "entry-icons", {
      "main.tsx": `
import { createRoot } from "react-dom/client";
import { FileIconSprite, FileTypeIcon, StrokeIcon } from "@shaulavo/workbench/icons";
createRoot(document.getElementById("root")!).render(
  <div>
    <FileIconSprite />
    <FileTypeIcon entry={{ name: "CLAUDE.md", type: "file" }} sprite />
    <StrokeIcon name="search" />
  </div>,
);
`,
    }),
  );

  // 3. `./tree` standalone WITHOUT WorkbenchShell (proving ref-counted sprite renders icons automatically)
  sites.push(
    buildVitePage(dirs.minReactDir, "entry-tree", {
      "main.tsx": `
import { createRoot } from "react-dom/client";
import { FileTreeModel, FileTreeView } from "@shaulavo/workbench/tree";
const model = new FileTreeModel({ paths: ["src/index.ts", "CLAUDE.md"], initialExpanded: ["src"] });
createRoot(document.getElementById("root")!).render(
  <div style={{ width: 280, height: 300 }}>
    <FileTreeView model={model} />
  </div>,
);
`,
    }),
  );

  // 4. `./preview` (named imports, zero manual CSS imports)
  sites.push(
    buildVitePage(dirs.minReactDir, "entry-preview", {
      "main.tsx": `
import { createRoot } from "react-dom/client";
import { PreviewPane } from "@shaulavo/workbench/preview";
const EMPTY_SERVERS: readonly never[] = [];
const adapter = {
  kind: "mounted" as const,
  servers: { getSnapshot: () => EMPTY_SERVERS, subscribe: () => () => {} },
  whenReady: async () => {},
  frameUrl: (p: number, path: string) => \`http://127.0.0.1:\${p}\${path}\`,
  tabUrl: (p: number, path: string) => \`http://127.0.0.1:\${p}\${path}\`,
  locate: () => undefined,
  attachFrame: () => ({ onFrameLoad: () => {}, navigate: () => {}, reload: () => {}, back: () => {}, forward: () => {}, dispose: () => {} }),
};
createRoot(document.getElementById("root")!).render(
  <div style={{ width: 420, height: 300 }}><PreviewPane adapter={adapter} /></div>,
);
`,
    }),
  );

  // 5. `./terminal` (named imports, zero manual CSS imports)
  sites.push(
    buildVitePage(dirs.fullPeerDir, "entry-terminal", {
      "main.tsx": `
import { createRoot } from "react-dom/client";
import { TerminalPanel } from "@shaulavo/workbench/terminal";
const EMPTY_SESSIONS: readonly never[] = [];
const adapter = {
  sessions: { getSnapshot: () => EMPTY_SESSIONS, subscribe: () => () => {} },
  activeId: { getSnapshot: () => undefined, subscribe: () => () => {} },
  createSession: async () => "t1",
  closeSession: async () => {},
  selectSession: () => {},
  renameSession: () => {},
  attach: async () => ({ write: () => {}, resize: () => {}, detach: () => {} }),
};
createRoot(document.getElementById("root")!).render(
  <div style={{ width: 480, height: 240 }}><TerminalPanel adapter={adapter} /></div>,
);
`,
    }),
  );

  // 6. `./editor` (bare editor peers, zero manual workbench OR Singapore CSS imports)
  sites.push(
    buildVitePage(dirs.bareEditorDir, "entry-editor", {
      "main.tsx": `
import { createRoot } from "react-dom/client";
import { EditorTabBar, CodeEditor } from "@shaulavo/workbench/editor";
const NO_CONFLICT = { getSnapshot: () => undefined, subscribe: () => () => {} };
const adapter = {
  getConflict: () => NO_CONFLICT,
  loadDocument: async () => ({ id: "a.ts", path: "src/a.ts", text: "export const ok = 1;\\n", revision: "1", byteLength: 21 }),
  writeIfUnchanged: async () => ({ written: true as const, nextRevision: "2" }),
  save: async () => {},
};
createRoot(document.getElementById("root")!).render(
  <div style={{ width: 520, height: 320, display: "flex", flexDirection: "column" }}>
    <EditorTabBar groupId="g1" tabs={[{ id: "t1", documentId: "a.ts", path: "src/a.ts", label: "a.ts" }]} selectedTabId="t1" onSelectTab={() => {}} onCloseTab={() => {}} />
    <CodeEditor adapter={adapter} documentId="a.ts" path="src/a.ts" />
  </div>,
);
`,
    }),
  );

  // 7. `./editor/groups` (pinned @dnd-kit/*, exercises drag reorder/move)
  sites.push(
    buildVitePage(dirs.fullPeerDir, "entry-editor-groups", {
      "main.tsx": `
import { createRoot } from "react-dom/client";
import { EditorGroupLayout, applyTabPlacement } from "@shaulavo/workbench/editor/groups";
const NO_CONFLICT = { getSnapshot: () => undefined, subscribe: () => () => {} };
const documents = {
  getConflict: () => NO_CONFLICT,
  loadDocument: async (id: string) => ({ id, path: id, text: \`export const file = "\${id}";\\n\`, revision: "1" }),
  writeIfUnchanged: async () => ({ written: true as const, revision: "2" }),
  save: async () => {},
};
let snap = {
  root: {
    kind: "split" as const,
    id: "split-1",
    axis: "horizontal" as const,
    children: [
      {
        size: 0.5,
        node: {
          kind: "group" as const,
          id: "g1",
          tabs: [{ id: "t1", documentId: "a.ts", path: "a.ts", label: "a.ts" }],
          selectedTabId: "t1",
        },
      },
      {
        size: 0.5,
        node: {
          kind: "group" as const,
          id: "g2",
          tabs: [{ id: "t2", documentId: "b.ts", path: "b.ts", label: "b.ts" }],
          selectedTabId: "t2",
        },
      },
    ] as const,
  },
  activeGroupId: "g1",
};
const listeners = new Set<() => void>();
const notify = () => { for (const fn of listeners) fn(); };
const groups = {
  groups: {
    getSnapshot: () => snap,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  },
  selectTab: (gid: string) => { snap = { ...snap, activeGroupId: gid }; notify(); },
  openDocument: () => {},
  closeTabs: () => {},
  pinTab: () => {},
  placeTab: (placement: Parameters<typeof applyTabPlacement>[1]) => {
    snap = applyTabPlacement(snap, placement);
    notify();
  },
};
createRoot(document.getElementById("root")!).render(
  <div style={{ width: 640, height: 280 }}><EditorGroupLayout documents={documents} groups={groups} /></div>,
);
`,
    }),
  );

  // 8. `./editor/lsp` (verifies DiagnosticPeek close StrokeIcon gets icons.css)
  sites.push(
    buildVitePage(dirs.fullPeerDir, "entry-editor-lsp", {
      "main.tsx": `
import { createRoot } from "react-dom/client";
import { DiagnosticPeek, LspStatusBadge } from "@shaulavo/workbench/editor/lsp";
const READY_STATUS = { state: "ready" as const, languageId: "typescript" };
const EMPTY_DIAGS: readonly never[] = [];
const lsp = {
  status: { getSnapshot: () => READY_STATUS, subscribe: () => () => {} },
  diagnosticsForDocument: () => ({ getSnapshot: () => EMPTY_DIAGS, subscribe: () => () => {} }),
};
const model = {
  severity: "error" as const,
  message: "Type mismatch",
  geometry: {
    kind: "visible" as const,
    anchorRect: { top: 40, right: 80, bottom: 60, left: 20, width: 60, height: 20 },
    clipRect: { top: 0, right: 800, bottom: 600, left: 0, width: 800, height: 600 },
  },
  relatedInformation: [],
};
createRoot(document.getElementById("root")!).render(
  <div style={{ position: "relative", width: 800, height: 600 }}>
    <LspStatusBadge adapter={lsp} />
    <DiagnosticPeek model={model} onClose={() => {}} />
  </div>,
);
`,
    }),
  );

  // 9. `./editor/composer` (named import, zero manual CSS imports)
  sites.push(
    buildVitePage(dirs.fullPeerDir, "entry-editor-composer", {
      "main.tsx": `
import { createRoot } from "react-dom/client";
import { MarkdownComposer } from "@shaulavo/workbench/editor/composer";
createRoot(document.getElementById("root")!).render(
  <div style={{ width: 420 }}><MarkdownComposer defaultValue="Hello @src/App.tsx" /></div>,
);
`,
    }),
  );

  // 10. `./editor/diff` (named import, zero manual CSS imports)
  sites.push(
    buildVitePage(dirs.fullPeerDir, "entry-editor-diff", {
      "main.tsx": `
import { createRoot } from "react-dom/client";
import { DiffEditorView } from "@shaulavo/workbench/editor/diff";
createRoot(document.getElementById("root")!).render(
  <div style={{ width: 520, height: 280 }}>
    <DiffEditorView originalText={"const a = 1;\\n"} modifiedText={"const a = 2;\\n"} path="src/a.ts" />
  </div>,
);
`,
    }),
  );

  // 11. Tailwind v4 Fregat host-precedence + oklch() exact-match + syntax token mapping + lazy ./tree
  const tailwindSite = buildVitePage(
    dirs.fullPeerDir,
    "entry-tailwind-fregat",
    {
      "app.css": `
@import "@shaulavo/workbench/layers.css";
@import "tailwindcss";
@import "@shaulavo/workbench/tailwind.css";
@import "@shaulavo/workbench/themes/fregat.css";

:root {
  --background: oklch(0.95 0.01 250);
  --content-well: oklch(0.91 0.03 210);
  --foreground: oklch(0.24 0.04 260);
  --warning: oklch(0.71 0.17 72);
  --accent: oklch(0.62 0.21 255);
  --density-row-padding-x: 14px;
  --density-row-padding-y: 7px;
}

.dark {
  --background: oklch(0.16 0.02 250);
  --content-well: oklch(0.22 0.04 235);
  --foreground: oklch(0.89 0.03 245);
  --warning: oklch(0.81 0.16 82);
  --accent: oklch(0.72 0.19 250);
}

@theme inline {
  --color-accent: var(--accent);
}
`,
      "main.tsx": `
import "./app.css";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { InlineRenameInput, WorkbenchShell } from "@shaulavo/workbench";
import { buildWorkbenchEditorTheme } from "@shaulavo/workbench/editor";

function App() {
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  const [treeLoaded, setTreeLoaded] = useState(false);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", scheme === "dark");
    document.documentElement.setAttribute("data-theme", scheme);
  }, [scheme]);

  useEffect(() => {
    void import("@shaulavo/workbench/tree").then(() => setTreeLoaded(true));
  }, []);

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__probe = {
      setScheme,
      buildTheme: (el: Element) => buildWorkbenchEditorTheme(el),
    };
  }, []);

  return (
    <WorkbenchShell theme="fregat" colorScheme={scheme} data-testid="fregat-shell" data-tree-loaded={treeLoaded ? "true" : "false"}>
      <div id="probe-well" style={{ backgroundColor: "var(--content-well)" }} />
      <div id="probe-fg" style={{ color: "var(--foreground)" }} />
      <div id="probe-warn" style={{ backgroundColor: "color-mix(in oklab, var(--warning) 20%, transparent)" }} />
      <div id="probe-accent" style={{ backgroundColor: "var(--accent)" }} />
      <InlineRenameInput data-testid="plain-rename" initialValue="plain.ts" onCommit={() => {}} onCancel={() => {}} />
      <InlineRenameInput
        data-testid="tw-rename"
        className="bg-accent h-auto border-transparent px-(--density-row-padding-x) py-(--density-row-padding-y)"
        initialValue="tw.ts"
        onCommit={() => {}}
        onCancel={() => {}}
      />
      <div
        id="syntax-host"
        style={{
          ["--wb-syn-function" as string]: "rgb(11, 22, 33)",
          ["--wb-syn-property" as string]: "rgb(44, 55, 66)",
          ["--wb-syn-attr" as string]: "rgb(77, 88, 99)",
          ["--wb-syn-variable" as string]: "rgb(110, 120, 130)",
          ["--wb-warn" as string]: "rgb(200, 140, 20)",
        }}
      />
    </WorkbenchShell>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
`,
    },
    { useTailwind: true },
  );
  assertCssAssetUniqueness(tailwindSite.distDir);
  sites.push(tailwindSite);

  // 12. Packed SSR renderToString + Playwright hydrateRoot dark-phone hydration test
  const ssrScriptPath = path.join(dirs.minReactDir, "render-ssr.tsx");
  writeFileSync(
    ssrScriptPath,
    `
import { renderToString } from "react-dom/server";
import { WorkbenchShell, useViewportMode, useWorkbenchTheme } from "@shaulavo/workbench";
import { FileIconSprite, FileTypeIcon, StrokeIcon } from "@shaulavo/workbench/icons";
function SsrApp() {
  const viewport = useViewportMode();
  const theme = useWorkbenchTheme(null);
  return (
    <WorkbenchShell theme="fregat" colorScheme={theme.scheme}>
      <FileIconSprite />
      <div data-testid="hydrate-state" data-viewport={viewport} data-scheme={theme.scheme}>{viewport}:{theme.scheme}</div>
      <FileTypeIcon entry={{ name: "CLAUDE.md", type: "file" }} sprite />
      <StrokeIcon name="search" />
    </WorkbenchShell>
  );
}
process.stdout.write(renderToString(<SsrApp />));
`,
  );
  const ssrHtml = runCmd("bun", [ssrScriptPath], dirs.minReactDir);
  sites.push(
    buildVitePage(
      dirs.minReactDir,
      "entry-ssr-hydrate",
      {
        "main.tsx": `
import { hydrateRoot } from "react-dom/client";
import { WorkbenchShell, useViewportMode, useWorkbenchTheme } from "@shaulavo/workbench";
import { FileIconSprite, FileTypeIcon, StrokeIcon } from "@shaulavo/workbench/icons";
function SsrApp() {
  const viewport = useViewportMode();
  const theme = useWorkbenchTheme(null);
  return (
    <WorkbenchShell theme="fregat" colorScheme={theme.scheme}>
      <FileIconSprite />
      <div data-testid="hydrate-state" data-viewport={viewport} data-scheme={theme.scheme}>{viewport}:{theme.scheme}</div>
      <FileTypeIcon entry={{ name: "CLAUDE.md", type: "file" }} sprite />
      <StrokeIcon name="search" />
    </WorkbenchShell>
  );
}
hydrateRoot(document.getElementById("root")!, <SsrApp />);
`,
      },
      { ssrHtml, htmlAttrs: 'class="dark" data-theme="dark"' },
    ),
  );

  return sites;
}

async function verifyEngine(browser: Browser, engineName: string, baseUrl: string): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });

  try {
    // 1. `.` root entry
    await page.goto(`${baseUrl}/entry-root/`);
    await page.waitForSelector(".wb-inline-rename-input");
    const rootOk = await page.evaluate(() => {
      const scope = document.querySelector<HTMLElement>("[data-wb-theme-scope]")!;
      const bgVar = getComputedStyle(scope).getPropertyValue("--wb-bg").trim();
      const input = document.querySelector<HTMLElement>(".wb-inline-rename-input")!;
      return Boolean(bgVar) && getComputedStyle(input).borderTopStyle === "solid";
    });
    if (!rootOk) throw new Error(`[${engineName}] entry-root missing auto-imported tokens/ui CSS`);

    // 2. `./icons`
    await page.goto(`${baseUrl}/entry-icons/`);
    await page.waitForSelector("svg[data-wb-icon-sprite]", { state: "attached" });
    await page.waitForSelector(".wb-stroke-icon");
    const iconsOk = await page.evaluate(() => {
      const stroke = document.querySelector<SVGSVGElement>(".wb-stroke-icon")!;
      const icon = document.querySelector<SVGSVGElement>(".wb-icon")!;
      const rect = icon.getBoundingClientRect();
      return getComputedStyle(stroke).fill === "none" && rect.width > 0 && rect.height > 0;
    });
    if (!iconsOk) throw new Error(`[${engineName}] entry-icons missing auto-imported icons CSS or sprite`);

    // 3. `./tree` standalone without WorkbenchShell
    await page.goto(`${baseUrl}/entry-tree/`);
    await page.waitForSelector('[data-testid="wb-tree-row-CLAUDE.md"]');
    const treeIconOk = await page.evaluate(() => {
      const sprite = document.body.querySelector("svg[data-wb-icon-sprite]");
      const symbol = document.getElementById("wb-file-icon-claude");
      const icon = document.querySelector<SVGSVGElement>('[data-testid="wb-tree-row-CLAUDE.md"] svg.wb-icon');
      const rect = icon?.getBoundingClientRect();
      return Boolean(sprite && symbol && rect && rect.width > 0 && rect.height > 0);
    });
    if (!treeIconOk) {
      throw new Error(`[${engineName}] entry-tree standalone failed to mount ref-counted icon sprite`);
    }

    // 4. `./preview`
    await page.goto(`${baseUrl}/entry-preview/`);
    await page.waitForSelector(".wb-preview-pane");
    const previewDisplay = await page.$eval(".wb-preview-pane", (el) => getComputedStyle(el).display);
    if (previewDisplay !== "flex") {
      throw new Error(`[${engineName}] entry-preview missing preview.css (display=${previewDisplay})`);
    }

    // 5. `./terminal`
    await page.goto(`${baseUrl}/entry-terminal/`);
    await page.waitForSelector(".wb-terminal-panel");
    const termDisplay = await page.$eval(".wb-terminal-panel", (el) => getComputedStyle(el).display);
    if (termDisplay !== "flex") {
      throw new Error(`[${engineName}] entry-terminal missing terminal.css (display=${termDisplay})`);
    }

    // 6. `./editor` (Workbench + Singapore auto-imported renderer & Find CSS)
    await page.goto(`${baseUrl}/entry-editor/`);
    await page.waitForSelector(".wb-editor-view");
    const editorCssOk = await page.evaluate(() => {
      const viewDisplay = getComputedStyle(document.querySelector(".wb-editor-view")!).display;
      const cssText = Array.from(document.styleSheets)
        .flatMap((sheet) => {
          try {
            return Array.from(sheet.cssRules, (rule) => rule.cssText);
          } catch {
            return [];
          }
        })
        .join("\n");
      const hasSingaporeRenderer = cssText.includes("--editor-z-gutter");
      const hasFindWidget = cssText.includes(".editor-find-widget");
      return viewDisplay === "flex" && hasSingaporeRenderer && hasFindWidget;
    });
    if (!editorCssOk) {
      throw new Error(`[${engineName}] entry-editor missing Workbench or Singapore auto-imported CSS`);
    }

    // 7. `./editor/groups` (including tab drag between groups)
    await page.goto(`${baseUrl}/entry-editor-groups/`);
    await page.waitForSelector(".wb-editor-groups-root");
    const groupsDisplay = await page.$eval(".wb-editor-groups-root", (el) => getComputedStyle(el).display);
    if (groupsDisplay !== "flex") {
      throw new Error(`[${engineName}] entry-editor-groups missing editor.css (display=${groupsDisplay})`);
    }
    const sourceTab = page.locator('[data-testid="wb-editor-tab-t1"]');
    const targetGroup = page.locator('[data-testid="wb-editor-group-g2"]');
    await sourceTab.waitFor({ state: "visible" });
    await targetGroup.waitFor({ state: "visible" });
    const srcBox = await sourceTab.boundingBox();
    const dstBox = await targetGroup.boundingBox();
    if (!srcBox || !dstBox) throw new Error(`[${engineName}] entry-editor-groups missing tab/group boxes`);
    const dstX = dstBox.x + dstBox.width / 2;
    const dstY = dstBox.y + dstBox.height / 2;
    await page.mouse.move(srcBox.x + srcBox.width / 2, srcBox.y + srcBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(srcBox.x + srcBox.width / 2 + 12, srcBox.y + srcBox.height / 2, { steps: 3 });
    await page.waitForSelector('[data-testid="wb-group-drop-overlay-g2"]');
    await page.mouse.move(dstX, dstY, { steps: 10 });
    await page.mouse.move(dstX + 1, dstY);
    await page.waitForSelector('[data-testid="wb-editor-group-g2"][data-drop-over="true"]');
    await page.mouse.up();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="wb-editor-group-g2"] [data-testid="wb-editor-tab-t1"]') !==
        null,
    );

    // 8. `./editor/lsp` (DiagnosticPeek + close StrokeIcon receives icons.css)
    await page.goto(`${baseUrl}/entry-editor-lsp/`);
    await page.waitForSelector(".wb-diagnostic-peek");
    const lspOk = await page.evaluate(() => {
      const peek = document.querySelector<HTMLElement>(".wb-diagnostic-peek")!;
      const closeIcon = peek.querySelector<SVGSVGElement>(".wb-stroke-icon")!;
      return getComputedStyle(peek).position === "absolute" && getComputedStyle(closeIcon).fill === "none";
    });
    if (!lspOk) throw new Error(`[${engineName}] entry-editor-lsp missing editor.css or icons.css`);

    // 9. `./editor/composer`
    await page.goto(`${baseUrl}/entry-editor-composer/`);
    await page.waitForSelector(".wb-composer");
    const composerPos = await page.$eval(".wb-composer", (el) => getComputedStyle(el).position);
    if (composerPos !== "relative") {
      throw new Error(`[${engineName}] entry-editor-composer missing editor.css (position=${composerPos})`);
    }

    // 10. `./editor/diff`
    await page.goto(`${baseUrl}/entry-editor-diff/`);
    await page.waitForSelector(".wb-diff-view");
    const diffDisplay = await page.$eval(".wb-diff-view", (el) => getComputedStyle(el).display);
    if (diffDisplay !== "flex") {
      throw new Error(`[${engineName}] entry-editor-diff missing editor.css (display=${diffDisplay})`);
    }

    // 11. Tailwind v4 host-precedence + Fregat oklch() exact-match (light + dark) + syntax token mapping
    await page.goto(`${baseUrl}/entry-tailwind-fregat/`);
    await page.waitForSelector('[data-testid="fregat-shell"][data-tree-loaded="true"]');
    const twResult = await page.evaluate(() => {
      const resolveColor = (cssColor: string): string => {
        const probe = document.createElement("div");
        probe.style.backgroundColor = cssColor;
        document.body.appendChild(probe);
        const computed = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return computed;
      };
      const plain = document.querySelector<HTMLElement>('[data-testid="plain-rename"]')!;
      const tw = document.querySelector<HTMLElement>('[data-testid="tw-rename"]')!;
      const accentColor = getComputedStyle(document.getElementById("probe-accent")!).backgroundColor;
      const twStyle = getComputedStyle(tw);
      const plainStyle = getComputedStyle(plain);
      const utilityWins =
        twStyle.backgroundColor === accentColor &&
        twStyle.paddingLeft === "14px" &&
        twStyle.paddingTop === "7px" &&
        plainStyle.borderTopStyle === "solid" &&
        plainStyle.backgroundColor !== accentColor;

      const probe = (
        window as unknown as {
          __probe: {
            setScheme: (s: "light" | "dark") => void;
            buildTheme: (el: Element) => {
              backgroundColor: string;
              foregroundColor: string;
              colors?: Record<string, string>;
              syntax?: Record<string, string>;
            };
          };
        }
      ).__probe;

      const checkScheme = (): { readonly ok: boolean; readonly detail: string } => {
        const shell = document.querySelector('[data-testid="fregat-shell"]')!;
        const built = probe.buildTheme(shell);
        const refWell = getComputedStyle(document.getElementById("probe-well")!).backgroundColor;
        const refFg = getComputedStyle(document.getElementById("probe-fg")!).color;
        const refWarn = getComputedStyle(document.getElementById("probe-warn")!).backgroundColor;
        const gotBg = resolveColor(built.backgroundColor);
        const gotFg = resolveColor(built.foregroundColor);
        const gotWarn = resolveColor(built.colors?.["lsp.diagnostic.warningBackground"] ?? "");
        const ok = gotBg === refWell && gotFg === refFg && gotWarn === refWarn;
        return {
          ok,
          detail: `bg=${gotBg} vs ${refWell}; fg=${gotFg} vs ${refFg}; warn=${gotWarn} vs ${refWarn}`,
        };
      };

      const lightCheck = checkScheme();
      const synHost = document.getElementById("syntax-host")!;
      const synTheme = probe.buildTheme(synHost);
      const syntaxOk =
        synTheme.syntax?.function === "rgb(11, 22, 33)" &&
        synTheme.syntax?.property === "rgb(44, 55, 66)" &&
        synTheme.syntax?.attribute === "rgb(77, 88, 99)" &&
        synTheme.syntax?.variable === "rgb(110, 120, 130)" &&
        (synTheme.colors?.["lsp.diagnostic.warningBackground"] ?? "").includes("rgb(200, 140, 20)");

      return { utilityWins, lightCheck, syntaxOk };
    });
    if (!twResult.utilityWins) {
      throw new Error(`[${engineName}] Tailwind v4 InlineRenameInput precedence check failed`);
    }
    if (!twResult.lightCheck.ok) {
      throw new Error(`[${engineName}] Fregat oklch light exact-match failed: ${twResult.lightCheck.detail}`);
    }
    if (!twResult.syntaxOk) {
      throw new Error(`[${engineName}] Syntax token mapping check failed`);
    }
    // Switch Fregat fixture to dark mode and re-assert exact oklch() match.
    await page.evaluate(() => {
      (window as unknown as { __probe: { setScheme: (s: "dark") => void } }).__probe.setScheme("dark");
    });
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    const darkCheck = await page.evaluate(() => {
      const resolveColor = (cssColor: string): string => {
        const probeEl = document.createElement("div");
        probeEl.style.backgroundColor = cssColor;
        document.body.appendChild(probeEl);
        const computed = getComputedStyle(probeEl).backgroundColor;
        probeEl.remove();
        return computed;
      };
      const shell = document.querySelector('[data-testid="fregat-shell"]')!;
      const built = (
        window as unknown as {
          __probe: {
            buildTheme: (el: Element) => {
              backgroundColor: string;
              foregroundColor: string;
              colors?: Record<string, string>;
            };
          };
        }
      ).__probe.buildTheme(shell);
      const refWell = getComputedStyle(document.getElementById("probe-well")!).backgroundColor;
      const refFg = getComputedStyle(document.getElementById("probe-fg")!).color;
      const refWarn = getComputedStyle(document.getElementById("probe-warn")!).backgroundColor;
      const gotBg = resolveColor(built.backgroundColor);
      const gotFg = resolveColor(built.foregroundColor);
      const gotWarn = resolveColor(built.colors?.["lsp.diagnostic.warningBackground"] ?? "");
      return {
        ok: gotBg === refWell && gotFg === refFg && gotWarn === refWarn,
        detail: `bg=${gotBg} vs ${refWell}; fg=${gotFg} vs ${refFg}; warn=${gotWarn} vs ${refWarn}`,
      };
    });
    if (!darkCheck.ok) {
      throw new Error(`[${engineName}] Fregat oklch dark exact-match failed: ${darkCheck.detail}`);
    }

    if (errors.length > 0) {
      throw new Error(`[${engineName}] unexpected runtime errors:\n${errors.join("\n")}`);
    }
  } finally {
    await context.close();
  }

  // 12. Dark phone (390x844) SSR renderToString + hydrateRoot test (zero hydration warnings/errors)
  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phonePage = await phoneCtx.newPage();
  const hydrateIssues: string[] = [];
  phonePage.on("pageerror", (err) => hydrateIssues.push(`pageerror: ${err.message}`));
  phonePage.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") {
      hydrateIssues.push(`console.${msg.type()}: ${msg.text()}`);
    }
  });
  try {
    await phonePage.goto(`${baseUrl}/entry-ssr-hydrate/`);
    await phonePage.waitForFunction(() => {
      const el = document.querySelector<HTMLElement>('[data-testid="hydrate-state"]');
      return el?.dataset.viewport === "phone" && el?.dataset.scheme === "dark";
    });
    const spriteCount = await phonePage.evaluate(() => {
      const sprites = document.body.querySelectorAll("svg[data-wb-icon-sprite]");
      const symbols = sprites[0] ? Array.from(sprites[0].querySelectorAll("symbol"), (s) => s.id) : [];
      return { sprites: sprites.length, uniqueSymbols: new Set(symbols).size, totalSymbols: symbols.length };
    });
    if (spriteCount.sprites !== 1 || spriteCount.uniqueSymbols !== spriteCount.totalSymbols) {
      throw new Error(`[${engineName}] SSR hydration sprite check failed: ${JSON.stringify(spriteCount)}`);
    }
    if (hydrateIssues.length > 0) {
      throw new Error(
        `[${engineName}] dark-phone SSR hydration emitted warnings/errors:\n${hydrateIssues.join("\n")}`,
      );
    }
  } finally {
    await phoneCtx.close();
  }
}

export async function runPackedBrowserChecks(dirs: PackedBrowserCheckDirs): Promise<void> {
  const sites = buildAllSites(dirs);
  const { server, baseUrl } = await startStaticServer(sites);
  const browsers: { readonly name: string; readonly instance: Browser }[] = [];
  try {
    browsers.push({ name: "chromium", instance: await chromium.launch() });
    browsers.push({ name: "webkit", instance: await webkit.launch() });
    for (const browser of browsers) {
      await verifyEngine(browser.instance, browser.name, baseUrl);
    }
  } finally {
    for (const browser of browsers) {
      await browser.instance.close();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
