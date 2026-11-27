import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CandidateManifest } from "./pack-release";
import { runPackedBrowserChecks } from "./pack-check-browser";

interface PackCheckRecord {
  readonly ciRunId: string | null;
  readonly ciRunAttempt: string | null;
  readonly workflowEvent: string | null;
  readonly gitCommit: string;
  readonly gitTree: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly tarballFile: string;
  readonly verifiedSha256: string;
  readonly dirty: boolean;
}

const ROOT = process.cwd();
const ALL_JS_SUBPATHS = [
  "@shaulavo/workbench",
  "@shaulavo/workbench/core",
  "@shaulavo/workbench/tokens",
  "@shaulavo/workbench/icons/core",
  "@shaulavo/workbench/icons",
  "@shaulavo/workbench/tree/model",
  "@shaulavo/workbench/tree",
  "@shaulavo/workbench/terminal",
  "@shaulavo/workbench/preview",
  "@shaulavo/workbench/editor",
  "@shaulavo/workbench/editor/groups",
  "@shaulavo/workbench/editor/lsp",
  "@shaulavo/workbench/editor/composer",
  "@shaulavo/workbench/editor/diff",
] as const;

const REQUIRED_CSS_EXPORTS = [
  "@shaulavo/workbench/layers.css",
  "@shaulavo/workbench/reset.css",
  "@shaulavo/workbench/tailwind.css",
  "@shaulavo/workbench/themes/fregat.css",
  "@shaulavo/workbench/themes/sprockt.css",
] as const;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function run(cmd: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Command failed (${cmd} ${args.join(" ")}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function findPhysicalPackageDirs(nodeModulesDir: string, pkgName: string): Set<string> {
  const found = new Set<string>();
  const bunStore = path.join(nodeModulesDir, ".bun");
  if (existsSync(bunStore)) {
    for (const entry of readdirSync(bunStore)) {
      const candidate = path.join(bunStore, entry, "node_modules", pkgName, "package.json");
      if (existsSync(candidate)) found.add(realpathSync(path.dirname(candidate)));
    }
  }
  const top = path.join(nodeModulesDir, pkgName, "package.json");
  if (existsSync(top)) found.add(realpathSync(path.dirname(top)));
  return found;
}

function validateArgsAndManifest(): {
  readonly tarballPath: string;
  readonly manifest: CandidateManifest;
  readonly verifiedSha256: string;
  readonly recordPath: string | undefined;
} {
  const tarballArg = argValue("--tarball");
  const manifestArg = argValue("--manifest");
  const recordArg = argValue("--record");
  if (!tarballArg || !manifestArg) {
    throw new Error("Usage: bun scripts/pack-check.ts --tarball <path> --manifest <path> [--record <path>]");
  }
  const tarballPath = path.resolve(ROOT, tarballArg);
  const manifestPath = path.resolve(ROOT, manifestArg);
  if (!existsSync(tarballPath)) throw new Error(`Tarball not found: ${tarballPath}`);
  if (!existsSync(manifestPath)) throw new Error(`Manifest not found: ${manifestPath}`);

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CandidateManifest;
  const verifiedSha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
  if (verifiedSha256 !== manifest.sha256) {
    throw new Error(`Tarball SHA-256 mismatch: expected ${manifest.sha256}, computed ${verifiedSha256}`);
  }
  if (path.basename(tarballPath) !== manifest.tarballFile) {
    throw new Error(
      `Tarball filename mismatch: manifest expects ${manifest.tarballFile}, got ${path.basename(tarballPath)}`,
    );
  }

  const pkgManifest = JSON.parse(
    readFileSync(path.join(ROOT, "packages/workbench/package.json"), "utf8"),
  ) as { readonly name: string; readonly version: string };
  if (manifest.packageName !== pkgManifest.name || manifest.packageVersion !== pkgManifest.version) {
    throw new Error(
      `Manifest package ${manifest.packageName}@${manifest.packageVersion} mismatches packages/workbench/package.json (${pkgManifest.name}@${pkgManifest.version})`,
    );
  }

  if (!manifest.dirty) {
    const headCommit = run("git", ["rev-parse", "HEAD"], ROOT);
    const headTree = run("git", ["rev-parse", "HEAD^{tree}"], ROOT);
    if (manifest.gitCommit !== headCommit || manifest.gitTree !== headTree) {
      throw new Error(
        `Clean manifest git metadata (${manifest.gitCommit}/${manifest.gitTree}) mismatches HEAD (${headCommit}/${headTree})`,
      );
    }
  }

  const listing = run("tar", ["-tzf", tarballPath], path.dirname(tarballPath)).split("\n");
  for (const required of [
    "package/LICENSE",
    "package/NOTICE",
    "package/THIRD_PARTY_NOTICES.txt",
    "package/package.json",
  ]) {
    if (!listing.includes(required)) {
      throw new Error(`Tarball missing required file ${required}`);
    }
  }
  if (listing.some((file) => /node_modules\/(?:react|@base-ui\/react|@singapore-editor)\b/.test(file))) {
    throw new Error("Tarball unexpectedly bundled react, @base-ui/react, or @singapore-editor");
  }

  return {
    tarballPath,
    manifest,
    verifiedSha256,
    recordPath: recordArg ? path.resolve(ROOT, recordArg) : undefined,
  };
}

function scanRelativeSpecifiers(filePath: string): readonly string[] {
  const source = readFileSync(filePath, "utf8");
  const matches: string[] = [];
  const re = /(?:from|import)\s*(?:\(\s*)?["'](\.[^"']+)["']/g;
  let match = re.exec(source);
  while (match) {
    if (match[1]) matches.push(match[1]);
    match = re.exec(source);
  }
  return matches;
}

function resolveRelativeTarget(current: string, spec: string, isDts: boolean): string {
  const resolvedBase = path.resolve(path.dirname(current), spec);
  if (isDts) return resolvedBase.replace(/\.js$/, ".d.ts");
  return existsSync(resolvedBase) ? resolvedBase : `${resolvedBase}.js`;
}

function verifyTransitiveTreeModelPortability(pkgRoot: string): void {
  const distDir = path.join(pkgRoot, "dist");
  const checkGraph = (entryRel: string, isDts: boolean): void => {
    const visited = new Set<string>();
    const queue = [path.join(distDir, entryRel)];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const specs = scanRelativeSpecifiers(current);
      for (const spec of specs) {
        if (spec.endsWith(".css")) {
          throw new Error(`Portable tree/model graph unexpectedly imported CSS: ${spec} from ${current}`);
        }
        const target = resolveRelativeTarget(current, spec, isDts);
        const relFromDist = path.relative(distDir, target).replaceAll(path.sep, "/");
        if (relFromDist === "core/index.js" || relFromDist === "core/index.d.ts") {
          throw new Error(`Portable tree/model graph must not reach ${relFromDist} (from ${current})`);
        }
        if (existsSync(target)) queue.push(target);
      }
      const source = readFileSync(current, "utf8");
      if (/\bfrom\s+["']react(?:\/[^"']*)?["']/.test(source)) {
        throw new Error(`Portable tree/model graph must not reference react: ${current}`);
      }
    }
  };
  checkGraph("tree/model.js", false);
  checkGraph("tree/model.d.ts", true);
}

function collectTransitiveJsSpecs(
  distDir: string,
  entryRel: string,
  jsTranspiler: Bun.Transpiler,
): Set<string> {
  const seenFiles = new Set<string>();
  const specs = new Set<string>();
  const queue = [path.join(distDir, entryRel)];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seenFiles.has(current) || !existsSync(current)) continue;
    seenFiles.add(current);
    const imported = jsTranspiler.scanImports(readFileSync(current, "utf8")).map((i) => i.path);
    for (const spec of imported) {
      specs.add(spec);
      if (!spec.startsWith(".") || spec.endsWith(".css")) continue;
      const next = path.resolve(path.dirname(current), spec);
      if (existsSync(next)) queue.push(next);
    }
  }
  return specs;
}

function verifyDistExternalImports(pkgRoot: string): void {
  const distDir = path.join(pkgRoot, "dist");
  const jsTranspiler = new Bun.Transpiler({ loader: "js" });
  const scanFile = (rel: string): Set<string> =>
    new Set(jsTranspiler.scanImports(readFileSync(path.join(distDir, rel), "utf8")).map((i) => i.path));

  const collectTransitiveSpecs = (entryRel: string): Set<string> =>
    collectTransitiveJsSpecs(distDir, entryRel, jsTranspiler);

  for (const headless of ["core/index.js", "tokens/index.js", "icons/core.js", "tree/model.js"]) {
    const specs = collectTransitiveSpecs(headless);
    for (const spec of specs) {
      if (
        spec === "react" ||
        spec.startsWith("react/") ||
        spec.endsWith(".css") ||
        spec.startsWith("@tanstack/")
      ) {
        throw new Error(`Headless entry ${headless} must not import ${spec}`);
      }
    }
  }

  for (const [entry, mustContain] of [
    ["index.js", ["react", "@base-ui/react"]],
    ["icons/index.js", ["react"]],
    ["tree/index.js", ["react"]],
    ["preview/index.js", ["react"]],
    ["terminal/index.js", ["react", "ghostty-webgpu", "ghostty-webgpu/hotkeys"]],
    ["editor/index.js", ["react", "@singapore-editor/core/editor"]],
    ["editor/groups/index.js", ["react", "@dnd-kit/core", "@dnd-kit/sortable"]],
    ["editor/lsp/index.js", ["react"]],
    ["editor/composer/index.js", ["react", "@singapore-editor/markdown"]],
    ["editor/diff/index.js", ["react", "@singapore-editor/diff"]],
  ] as const) {
    const specs = collectTransitiveSpecs(entry);
    for (const expected of mustContain) {
      const ok = Array.from(specs).some((s) => s === expected || s.startsWith(`${expected}/`));
      if (!ok) {
        throw new Error(
          `Entry ${entry} must keep ${expected} externalized (got: ${Array.from(specs).join(", ")})`,
        );
      }
    }
  }

  for (const nonTermEntry of ["index.js", "tree/index.js", "preview/index.js"]) {
    const specs = collectTransitiveSpecs(nonTermEntry);
    for (const spec of specs) {
      if (
        spec === "ghostty-webgpu" ||
        spec.startsWith("ghostty-webgpu/") ||
        spec.startsWith("@singapore-editor/") ||
        spec.startsWith("@dnd-kit/")
      ) {
        throw new Error(`${nonTermEntry} must not import ${spec}`);
      }
    }
  }

  const editorRootDirect = scanFile("editor/index.js");
  for (const forbidden of [
    "@dnd-kit/core",
    "@singapore-editor/diff",
    "@singapore-editor/markdown",
    "@singapore-editor/lsp-plugin",
  ]) {
    if (editorRootDirect.has(forbidden)) {
      throw new Error(`editor/index.js must not directly import optional subpath dep ${forbidden}`);
    }
  }
}

function runTsc(
  cwd: string,
  tsconfigName: string,
  config: Record<string, unknown>,
  entryFiles: Readonly<Record<string, string>>,
): void {
  for (const [name, content] of Object.entries(entryFiles)) {
    writeFileSync(path.join(cwd, name), content);
  }
  const tsconfigPath = path.join(cwd, tsconfigName);
  writeFileSync(tsconfigPath, JSON.stringify(config, null, 2));
  const tscBin = path.join(ROOT, "node_modules/.bin/tsc");
  run(tscBin, ["-p", tsconfigPath, "--noEmit"], cwd);
}

const { tarballPath, manifest, verifiedSha256, recordPath } = validateArgsAndManifest();

const rootManifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  readonly workspaces: { readonly catalog: Readonly<Record<string, string>> };
  readonly devDependencies: Readonly<Record<string, string>>;
};
const catalog = rootManifest.workspaces.catalog;
const catalogPin = (name: string): string => {
  const version = catalog[name] ?? rootManifest.devDependencies[name];
  if (!version) throw new Error(`Missing root catalog pin for ${name}`);
  return version;
};

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "workbench-pack-check-"));
const standaloneDir = path.join(tempRoot, "fixture-standalone");
const minReactDir = path.join(tempRoot, "fixture-min-react");
const iconsOnlyDir = path.join(tempRoot, "fixture-icons-only");
const bareEditorDir = path.join(tempRoot, "fixture-bare-editor");
const fullPeerDir = path.join(tempRoot, "fixture-full-peers");
for (const dir of [standaloneDir, minReactDir, iconsOnlyDir, bareEditorDir, fullPeerDir]) {
  mkdirSync(dir, { recursive: true });
}

try {
  // Fixture A: Standalone React-free, DOM-free, notice-file, createRequire().resolve(), Node + Bun import
  writeFileSync(
    path.join(standaloneDir, "package.json"),
    JSON.stringify(
      {
        name: "pack-consumer-standalone",
        private: true,
        type: "module",
        dependencies: { "@shaulavo/workbench": `file:${tarballPath}` },
      },
      null,
      2,
    ),
  );
  run("bun", ["install", "--linker=isolated"], standaloneDir);

  const standaloneNm = path.join(standaloneDir, "node_modules");
  for (const forbidden of [
    "react",
    "react-dom",
    "@base-ui/react",
    "ghostty-webgpu",
    "@singapore-editor/core",
    "@dnd-kit/core",
    "@tanstack/react-virtual",
  ]) {
    if (findPhysicalPackageDirs(standaloneNm, forbidden).size !== 0) {
      throw new Error(`Standalone fixture unexpectedly installed ${forbidden}`);
    }
  }
  if (findPhysicalPackageDirs(standaloneNm, "@shaulavo/hotkeys").size !== 1) {
    throw new Error("Expected 1 deduplicated @shaulavo/hotkeys in standalone fixture");
  }

  const installedPkgRoot = realpathSync(path.join(standaloneNm, "@shaulavo/workbench"));
  const noticesPath = path.join(installedPkgRoot, "THIRD_PARTY_NOTICES.txt");
  if (!existsSync(noticesPath)) throw new Error("Installed package missing THIRD_PARTY_NOTICES.txt");
  const noticesText = readFileSync(noticesPath, "utf8");
  for (const required of [
    "@pierre/vscode-icons",
    "@iconify-json/catppuccin",
    "simple-icons",
    "@tanstack/react-virtual",
    "@tanstack/virtual-core",
  ]) {
    if (!noticesText.includes(required)) {
      throw new Error(`Installed THIRD_PARTY_NOTICES.txt missing ${required}`);
    }
  }

  verifyTransitiveTreeModelPortability(installedPkgRoot);
  verifyDistExternalImports(installedPkgRoot);

  // Resolver-only createRequire().resolve() + CSS exports + Node & Bun ESM imports
  const headlessRuntimeCheck = `
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import * as core from "@shaulavo/workbench/core";
import * as tokens from "@shaulavo/workbench/tokens";
import * as iconsCore from "@shaulavo/workbench/icons/core";
import * as treeModel from "@shaulavo/workbench/tree/model";
if (!tokens.parseCssColor || !core.resolveActivationFocus || !core.createReplayGate) process.exit(1);
if (iconsCore.resolveFileIconName("CLAUDE.md") !== "claude") process.exit(1);
if (typeof treeModel.FileTreeModel !== "function" || typeof treeModel.bindFileSystemAdapter !== "function") process.exit(1);
const req = createRequire(process.cwd() + "/package.json");
for (const spec of ${JSON.stringify(ALL_JS_SUBPATHS)}) {
  const resolved = req.resolve(spec);
  if (!resolved.includes("/dist/")) throw new Error("createRequire.resolve did not land in /dist/ for " + spec + ": " + resolved);
}
for (const css of ${JSON.stringify(REQUIRED_CSS_EXPORTS)}) {
  const resolved = req.resolve(css);
  if (!existsSync(resolved)) throw new Error("Missing CSS export: " + css);
}
if (!existsSync(req.resolve("@shaulavo/workbench/THIRD_PARTY_NOTICES.txt"))) {
  throw new Error("Missing THIRD_PARTY_NOTICES.txt export");
}
`;
  run("node", ["--input-type=module", "-e", headlessRuntimeCheck], standaloneDir);
  run("bun", ["-e", headlessRuntimeCheck], standaloneDir);

  // Gate 2a: DOM-free portable .d.ts (Bundler AND strict NodeNext, lib: ["ES2024"], types: [])
  const domFreeCheckCode = `
import {
  FileTreeModel,
  bindFileSystemAdapter,
  isOptimisticTreeMutationConfirmed,
  prepareFileTreeInput,
  type DirEntry,
  type DirectoryLoadState,
  type EntryKind,
  type FileTreeGitState,
  type FileTreeSourceAdapter,
  type GitStatusCode,
  type IndexedTreePatch,
  type IndexedTreeSnapshot,
} from "@shaulavo/workbench/tree/model";
import {
  FILE_ICON_EXTENSIONS,
  FILE_ICON_FILE_NAMES,
  FILE_ICON_RULES,
  resolveFileIconName,
  type FileIconRule,
} from "@shaulavo/workbench/icons/core";
export type PortableCheck = [
  DirEntry,
  DirectoryLoadState,
  EntryKind,
  FileTreeGitState,
  FileTreeSourceAdapter,
  GitStatusCode,
  IndexedTreePatch,
  IndexedTreeSnapshot,
  FileIconRule,
];
export const portableValues = [
  FileTreeModel,
  bindFileSystemAdapter,
  isOptimisticTreeMutationConfirmed,
  prepareFileTreeInput,
  FILE_ICON_EXTENSIONS,
  FILE_ICON_FILE_NAMES,
  FILE_ICON_RULES,
  resolveFileIconName,
];
`;
  for (const [name, mod, res] of [
    ["tsconfig.domfree.bundler.json", "ESNext", "bundler"],
    ["tsconfig.domfree.nodenext.json", "NodeNext", "NodeNext"],
  ] as const) {
    runTsc(
      standaloneDir,
      name,
      {
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          lib: ["ES2024"],
          types: [],
          module: mod,
          moduleResolution: res,
        },
        include: ["check-domfree.ts"],
      },
      { "check-domfree.ts": domFreeCheckCode },
    );
  }

  // Gate 2b: React-free DOM-typed check (Bundler AND strict NodeNext, zero React installed)
  const reactFreeDomCode = `
import {
  resolveActivationFocus,
  createReplayGate,
  type EditorGroupTreeNode,
  type EntryKind,
  type IndexedTreePatch,
  type IndexedTreeSnapshot,
  type Space,
  type PreviewFrameController,
  type LspServerStatus,
} from "@shaulavo/workbench/core";
import { parseCssColor, observeWorkbenchTheme, resolveColorScheme } from "@shaulavo/workbench/tokens";
export type CoreDomCheck = [
  EditorGroupTreeNode,
  EntryKind,
  IndexedTreePatch,
  IndexedTreeSnapshot,
  Space,
  PreviewFrameController,
  LspServerStatus,
];
export const coreDomValues = [
  resolveActivationFocus,
  createReplayGate,
  parseCssColor,
  observeWorkbenchTheme,
  resolveColorScheme,
];
`;
  for (const [name, mod, res] of [
    ["tsconfig.core.bundler.json", "ESNext", "bundler"],
    ["tsconfig.core.nodenext.json", "NodeNext", "NodeNext"],
  ] as const) {
    runTsc(
      standaloneDir,
      name,
      {
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          types: [],
          module: mod,
          moduleResolution: res,
        },
        include: ["check-core-dom.ts"],
      },
      { "check-core-dom.ts": reactFreeDomCode },
    );
  }

  // Fixture B: Minimum-peer React root check (zero @tanstack/react-virtual, zero ghostty/singapore/dnd-kit)
  writeFileSync(
    path.join(minReactDir, "package.json"),
    JSON.stringify(
      {
        name: "pack-consumer-min-react",
        private: true,
        type: "module",
        dependencies: {
          "@shaulavo/workbench": `file:${tarballPath}`,
          "@base-ui/react": catalogPin("@base-ui/react"),
          react: catalogPin("react"),
          "react-dom": catalogPin("react-dom"),
        },
        devDependencies: {
          "@types/react": catalogPin("@types/react"),
          "@types/react-dom": catalogPin("@types/react-dom"),
          "@vitejs/plugin-react": catalogPin("@vitejs/plugin-react"),
          typescript: catalogPin("typescript"),
          vite: catalogPin("vite"),
        },
      },
      null,
      2,
    ),
  );
  run("bun", ["install", "--linker=isolated"], minReactDir);
  if (findPhysicalPackageDirs(path.join(minReactDir, "node_modules"), "@tanstack/react-virtual").size !== 0) {
    throw new Error("Minimum-peer React fixture unexpectedly installed @tanstack/react-virtual");
  }
  runTsc(
    minReactDir,
    "tsconfig.min-react.json",
    {
      compilerOptions: {
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        jsx: "react-jsx",
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        types: ["vite/client"],
        module: "ESNext",
        moduleResolution: "bundler",
      },
      include: ["check-min-react.tsx"],
    },
    {
      "check-min-react.tsx": `
import { useRef } from "react";
import {
  VirtualList,
  WorkbenchShell,
  useViewportMode,
  useWorkbenchTheme,
  type VirtualListHandle,
  type VirtualListMeasurement,
  type InlineRenameInputProps,
  type RenderErrorFallbackProps,
  type SearchMatch,
  type SearchQueryOptions,
} from "@shaulavo/workbench";
export function MinReactCheck(props: {
  readonly cache: readonly VirtualListMeasurement[];
  readonly rename?: InlineRenameInputProps;
  readonly fallback?: RenderErrorFallbackProps;
  readonly match?: SearchMatch;
  readonly query?: SearchQueryOptions;
}) {
  const ref = useRef<VirtualListHandle | null>(null);
  const vp = useViewportMode();
  const theme = useWorkbenchTheme(null);
  return (
    <WorkbenchShell shell={vp} colorScheme={theme.scheme}>
      <VirtualList
        ref={ref}
        items={["a", "b"]}
        getKey={(x) => x}
        initialMeasurementsCache={props.cache}
        renderRow={(x) => <div>{x}</div>}
      />
    </WorkbenchShell>
  );
}
`,
    },
  );

  // Fixture B2: Icons-only zero-@base-ui/react fixture
  writeFileSync(
    path.join(iconsOnlyDir, "package.json"),
    JSON.stringify(
      {
        name: "pack-consumer-icons-only",
        private: true,
        type: "module",
        dependencies: {
          "@shaulavo/workbench": `file:${tarballPath}`,
          react: catalogPin("react"),
          "react-dom": catalogPin("react-dom"),
        },
        devDependencies: {
          "@vitejs/plugin-react": catalogPin("@vitejs/plugin-react"),
          vite: catalogPin("vite"),
        },
      },
      null,
      2,
    ),
  );
  run("bun", ["install", "--linker=isolated"], iconsOnlyDir);
  if (findPhysicalPackageDirs(path.join(iconsOnlyDir, "node_modules"), "@base-ui/react").size !== 0) {
    throw new Error("Icons-only fixture unexpectedly installed @base-ui/react");
  }

  // Fixture C: Bare Sprockt-like consumer (editor root without @dnd-kit/*, diff, markdown, lsp)
  writeFileSync(
    path.join(bareEditorDir, "package.json"),
    JSON.stringify(
      {
        name: "pack-consumer-bare-editor",
        private: true,
        type: "module",
        dependencies: {
          "@shaulavo/workbench": `file:${tarballPath}`,
          "@base-ui/react": catalogPin("@base-ui/react"),
          "@shaulavo/hotkeys": catalogPin("@shaulavo/hotkeys"),
          "@singapore-editor/core": catalogPin("@singapore-editor/core"),
          "@singapore-editor/find": catalogPin("@singapore-editor/find"),
          "@singapore-editor/gutters": catalogPin("@singapore-editor/gutters"),
          "@singapore-editor/highlighting": catalogPin("@singapore-editor/highlighting"),
          "@singapore-editor/plugin-ui": catalogPin("@singapore-editor/plugin-ui"),
          "@singapore-editor/react": catalogPin("@singapore-editor/react"),
          react: catalogPin("react"),
          "react-dom": catalogPin("react-dom"),
        },
        devDependencies: {
          "@vitejs/plugin-react": catalogPin("@vitejs/plugin-react"),
          vite: catalogPin("vite"),
        },
      },
      null,
      2,
    ),
  );
  run("bun", ["install", "--linker=isolated"], bareEditorDir);
  for (const absent of [
    "@dnd-kit/core",
    "@dnd-kit/sortable",
    "@dnd-kit/utilities",
    "@singapore-editor/lsp",
    "@singapore-editor/lsp-plugin",
    "@singapore-editor/markdown",
    "ghostty-webgpu",
  ]) {
    if (findPhysicalPackageDirs(path.join(bareEditorDir, "node_modules"), absent).size !== 0) {
      throw new Error(`Bare editor fixture unexpectedly installed ${absent}`);
    }
  }
  if (existsSync(path.join(bareEditorDir, "node_modules/@singapore-editor/diff"))) {
    throw new Error("Bare editor fixture unexpectedly exposed @singapore-editor/diff at top level");
  }
  writeFileSync(
    path.join(bareEditorDir, "bare-entry.ts"),
    `import { EditorWorkbench, CodeEditor, EditorTabBar, buildWorkbenchEditorTheme, capOverscrollTop, createWorkbenchEditorPlugins, documentFeatureTier, languageIdForPath } from "@shaulavo/workbench/editor";\nexport const bare = { EditorWorkbench, CodeEditor, EditorTabBar, buildWorkbenchEditorTheme, capOverscrollTop, createWorkbenchEditorPlugins, documentFeatureTier, languageIdForPath };\n`,
  );
  run(
    "bun",
    [
      "-e",
      `const built = await Bun.build({ entrypoints: ["./bare-entry.ts"], target: "browser", outdir: "./bun-dist", format: "esm" });
       if (!built.success) { console.error(built.logs); process.exit(1); }
       const js = built.outputs.find((o) => o.path.endsWith(".js"));
       const css = built.outputs.find((o) => o.path.endsWith(".css"));
       if (!js || !css) throw new Error("Bare editor bundle missing JS or auto-imported CSS output");
       const text = await js.text();
       if (!text.includes("wb-editor-view")) throw new Error("Bare editor bundle missing CodeEditor");
       for (const forbidden of ["@dnd-kit", "ghostty-webgpu", "wb-markdown-composer", "wb-diagnostic-peek"]) {
         if (text.includes(forbidden)) throw new Error("Bare editor bundle unexpectedly included " + forbidden);
       }`,
    ],
    bareEditorDir,
  );

  // Fixture D: Full peer consumer (all catalog peers + Tailwind v4) + live consumer inventory typecheck
  writeFileSync(
    path.join(fullPeerDir, "package.json"),
    JSON.stringify(
      {
        name: "pack-consumer-full-peers",
        private: true,
        type: "module",
        dependencies: {
          "@shaulavo/workbench": `file:${tarballPath}`,
          "@base-ui/react": catalogPin("@base-ui/react"),
          "@dnd-kit/core": catalogPin("@dnd-kit/core"),
          "@dnd-kit/sortable": catalogPin("@dnd-kit/sortable"),
          "@dnd-kit/utilities": catalogPin("@dnd-kit/utilities"),
          "@shaulavo/hotkeys": catalogPin("@shaulavo/hotkeys"),
          "@singapore-editor/core": catalogPin("@singapore-editor/core"),
          "@singapore-editor/diff": catalogPin("@singapore-editor/diff"),
          "@singapore-editor/find": catalogPin("@singapore-editor/find"),
          "@singapore-editor/gutters": catalogPin("@singapore-editor/gutters"),
          "@singapore-editor/highlighting": catalogPin("@singapore-editor/highlighting"),
          "@singapore-editor/lsp": catalogPin("@singapore-editor/lsp"),
          "@singapore-editor/lsp-plugin": catalogPin("@singapore-editor/lsp-plugin"),
          "@singapore-editor/markdown": catalogPin("@singapore-editor/markdown"),
          "@singapore-editor/plugin-ui": catalogPin("@singapore-editor/plugin-ui"),
          "@singapore-editor/react": catalogPin("@singapore-editor/react"),
          "ghostty-webgpu": catalogPin("ghostty-webgpu"),
          react: catalogPin("react"),
          "react-dom": catalogPin("react-dom"),
        },
        devDependencies: {
          "@tailwindcss/vite": catalogPin("@tailwindcss/vite"),
          "@types/react": catalogPin("@types/react"),
          "@types/react-dom": catalogPin("@types/react-dom"),
          "@vitejs/plugin-react": catalogPin("@vitejs/plugin-react"),
          tailwindcss: catalogPin("tailwindcss"),
          typescript: catalogPin("typescript"),
          vite: catalogPin("vite"),
        },
      },
      null,
      2,
    ),
  );
  run("bun", ["install"], fullPeerDir);

  for (const singleton of [
    "@shaulavo/hotkeys",
    "@base-ui/react",
    "ghostty-webgpu",
    "@singapore-editor/core",
  ]) {
    const dirs = findPhysicalPackageDirs(path.join(fullPeerDir, "node_modules"), singleton);
    if (dirs.size !== 1) {
      throw new Error(`Expected 1 deduplicated ${singleton} in full-peer fixture, got ${dirs.size}`);
    }
  }

  // Gate 2d: Full live consumer import-inventory check (vibe-builder, harness, Sprockt, Fregat)
  runTsc(
    fullPeerDir,
    "tsconfig.inventory.json",
    {
      compilerOptions: {
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        jsx: "react-jsx",
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        types: ["vite/client"],
        module: "ESNext",
        moduleResolution: "bundler",
      },
      include: ["check-inventory.tsx"],
    },
    {
      "check-inventory.tsx": `
import {
  WorkbenchShell,
  DesktopSplitGrid,
  MobilePaneShell,
  ToolPane,
  TitleBar,
  StatusBar,
  InlineRenameInput,
  VirtualList,
  useSubscribable,
  useViewportMode,
  useWorkbenchTheme,
  type InlineRenameInputProps,
  type RenderErrorFallbackProps,
  type SearchMatch,
  type SearchQueryOptions,
} from "@shaulavo/workbench";
import {
  type WorkbenchCommand,
  type WorkbenchPaneId,
  type GlobalPaneGeometry,
  type Space,
  type EditorGroupTreeNode,
  type EntryKind,
  type IndexedTreePatch,
  type IndexedTreeSnapshot,
  type DocumentId,
  type GroupId,
  type TabId,
  type TabPlacement,
  type EditorGroupsSnapshot,
  type EditorTabDescriptor,
  type LoadedDocument,
  type OpenDocumentOptions,
  type DocumentConflict,
  type WriteOutcome,
  type MoveLockHandle,
  type TerminalSessionInfo,
  type TerminalSessionStatus,
  type TerminalSavedScroll,
  type PreviewFrameController,
  type PreviewServerInfo,
  type LspServerStatus,
} from "@shaulavo/workbench/core";
import {
  FILE_ICON_EXTENSIONS,
  FILE_ICON_FILE_NAMES,
  FileIconSprite,
  FileTypeIcon,
  StrokeIcon,
  type FileIconRule,
} from "@shaulavo/workbench/icons";
import {
  FileTreeModel,
  FileTreeView,
  isSameOrInside,
  type FileTreeGitState,
  type FileTreeKeyboardCommand,
  type FileTreeViewHandle,
} from "@shaulavo/workbench/tree";
import {
  TerminalPanel,
  TerminalView,
  TerminalAccessoryBar,
  TERMINAL_KEYS,
  controlKeyFor,
  type TerminalKey,
} from "@shaulavo/workbench/terminal";
import { PreviewPane } from "@shaulavo/workbench/preview";
import {
  CodeEditor,
  EditorWorkbench,
  EditorTabBar,
  MI_CODE_UNITS,
  type CodeEditorProps,
  type EditorRevealTarget,
  type EditorSessionAttachment,
} from "@shaulavo/workbench/editor";
import { EditorGroupLayout } from "@shaulavo/workbench/editor/groups";
import {
  DiagnosticPeek,
  LspStatusBadge,
  type DiagnosticPeekClientRect,
  type DiagnosticPeekPlacement,
  type SingaporeLspAdapter,
} from "@shaulavo/workbench/editor/lsp";
import { MarkdownComposer } from "@shaulavo/workbench/editor/composer";
import { DiffEditorView } from "@shaulavo/workbench/editor/diff";

export type AllConsumerTypes = [
  InlineRenameInputProps,
  RenderErrorFallbackProps,
  SearchMatch,
  SearchQueryOptions,
  WorkbenchCommand,
  WorkbenchPaneId,
  GlobalPaneGeometry,
  Space,
  EditorGroupTreeNode,
  EntryKind,
  IndexedTreePatch,
  IndexedTreeSnapshot,
  DocumentId,
  GroupId,
  TabId,
  TabPlacement,
  EditorGroupsSnapshot,
  EditorTabDescriptor,
  LoadedDocument,
  OpenDocumentOptions,
  DocumentConflict,
  WriteOutcome,
  MoveLockHandle,
  TerminalSessionInfo,
  TerminalSessionStatus,
  PreviewFrameController,
  PreviewServerInfo,
  LspServerStatus,
  FileIconRule,
  FileTreeGitState,
  FileTreeKeyboardCommand,
  FileTreeViewHandle,
  TerminalKey,
  TerminalSavedScroll,
  CodeEditorProps,
  EditorRevealTarget,
  EditorSessionAttachment,
  DiagnosticPeekClientRect,
  DiagnosticPeekPlacement,
  SingaporeLspAdapter,
];

export const allConsumerValues = [
  WorkbenchShell,
  DesktopSplitGrid,
  MobilePaneShell,
  ToolPane,
  TitleBar,
  StatusBar,
  InlineRenameInput,
  VirtualList,
  useSubscribable,
  useViewportMode,
  useWorkbenchTheme,
  FILE_ICON_EXTENSIONS,
  FILE_ICON_FILE_NAMES,
  FileIconSprite,
  FileTypeIcon,
  StrokeIcon,
  FileTreeModel,
  FileTreeView,
  isSameOrInside,
  TerminalPanel,
  TerminalView,
  TerminalAccessoryBar,
  TERMINAL_KEYS,
  controlKeyFor,
  PreviewPane,
  CodeEditor,
  EditorWorkbench,
  EditorTabBar,
  MI_CODE_UNITS,
  EditorGroupLayout,
  DiagnosticPeek,
  LspStatusBadge,
  MarkdownComposer,
  DiffEditorView,
];
`,
    },
  );

  // Independent per-entry browser checks + Tailwind v4 Fregat oklch() + dark-phone SSR hydrateRoot (Chromium & WebKit)
  await runPackedBrowserChecks({
    minReactDir,
    iconsOnlyDir,
    bareEditorDir,
    fullPeerDir,
  });

  if (recordPath) {
    const record: PackCheckRecord = {
      ciRunId: manifest.ciRunId,
      ciRunAttempt: manifest.ciRunAttempt,
      workflowEvent: manifest.workflowEvent,
      gitCommit: manifest.gitCommit,
      gitTree: manifest.gitTree,
      packageName: manifest.packageName,
      packageVersion: manifest.packageVersion,
      tarballFile: manifest.tarballFile,
      verifiedSha256,
      dirty: manifest.dirty,
    };
    mkdirSync(path.dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  }

  console.log(
    `pack-check: ok (${manifest.packageName}@${manifest.packageVersion} sha256=${verifiedSha256.slice(0, 12)}: standalone Node/Bun + NodeNext/Bundler strict tsc + external-runtime guard + 10 isolated named-import browser entries + Tailwind v4 oklch exact-match + dark-phone SSR hydrateRoot in Chromium & WebKit)`,
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
