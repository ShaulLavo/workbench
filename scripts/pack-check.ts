import { spawnSync } from "node:child_process";
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

const ROOT = process.cwd();
const PACKAGES = [
  "packages/tokens",
  "packages/core",
  "packages/icons",
  "packages/ui",
  "packages/tree",
  "packages/terminal",
  "packages/preview",
  "packages/editor",
] as const;
const REQUIRED_TOKEN_CSS_EXPORTS = [
  "@shaulavo/workbench-tokens/tokens.css",
  "@shaulavo/workbench-tokens/reset.css",
  "@shaulavo/workbench-tokens/tailwind-bridge.css",
  "@shaulavo/workbench-tokens/themes/fregat.css",
  "@shaulavo/workbench-tokens/themes/sprockt.css",
  "@shaulavo/workbench-icons/icons.css",
] as const;

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

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "workbench-pack-check-"));
const tarDir = path.join(tempRoot, "tarballs");
const reactFreeDir = path.join(tempRoot, "consumer-react-free");
const bareSprocktDir = path.join(tempRoot, "consumer-bare-sprockt");
const fullPeerDir = path.join(tempRoot, "consumer-full-peers");
mkdirSync(tarDir, { recursive: true });
mkdirSync(reactFreeDir, { recursive: true });
mkdirSync(bareSprocktDir, { recursive: true });
mkdirSync(fullPeerDir, { recursive: true });

try {
  const tarballs = new Map<string, string>();
  for (const relativePkg of PACKAGES) {
    const pkgDir = path.join(ROOT, relativePkg);
    const manifest = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8")) as {
      readonly name: string;
    };
    run("bun", ["pm", "pack", "--destination", tarDir, "--quiet"], pkgDir);
    const created = readdirSync(tarDir).find(
      (f) => f.endsWith(".tgz") && !Array.from(tarballs.values()).includes(path.join(tarDir, f)),
    );
    if (!created) throw new Error(`Missing packed tarball for ${manifest.name}`);
    const tgzPath = path.join(tarDir, created);
    tarballs.set(manifest.name, tgzPath);

    const listing = run("tar", ["-tzf", tgzPath], tarDir).split("\n");
    const requiredFiles =
      manifest.name === "@shaulavo/workbench-icons"
        ? ["package/LICENSE", "package/NOTICE", "package/THIRD_PARTY_NOTICES.txt", "package/package.json"]
        : ["package/LICENSE", "package/NOTICE", "package/package.json"];
    for (const required of requiredFiles) {
      if (!listing.includes(required)) {
        throw new Error(`${manifest.name} tarball missing ${required}`);
      }
    }
    if (listing.some((file) => /node_modules\/(?:react|@base-ui\/react|@singapore-editor)\b/.test(file))) {
      throw new Error(`${manifest.name} tarball unexpectedly bundled react, @base-ui/react, or singapore`);
    }
  }

  const reactFreeOverrides = {
    "@shaulavo/workbench-tokens": `file:${tarballs.get("@shaulavo/workbench-tokens")}`,
    "@shaulavo/workbench-core": `file:${tarballs.get("@shaulavo/workbench-core")}`,
    "@shaulavo/workbench-icons": `file:${tarballs.get("@shaulavo/workbench-icons")}`,
  };
  const allOverrides = {
    ...reactFreeOverrides,
    "@shaulavo/workbench-ui": `file:${tarballs.get("@shaulavo/workbench-ui")}`,
    "@shaulavo/workbench-tree": `file:${tarballs.get("@shaulavo/workbench-tree")}`,
    "@shaulavo/workbench-terminal": `file:${tarballs.get("@shaulavo/workbench-terminal")}`,
    "@shaulavo/workbench-preview": `file:${tarballs.get("@shaulavo/workbench-preview")}`,
    "@shaulavo/workbench-editor": `file:${tarballs.get("@shaulavo/workbench-editor")}`,
  };

  // Fixture A: React-free root consumer (tokens + core + icons, ZERO react installed).
  writeFileSync(
    path.join(reactFreeDir, "package.json"),
    JSON.stringify(
      {
        name: "pack-consumer-react-free",
        private: true,
        type: "module",
        dependencies: reactFreeOverrides,
        overrides: reactFreeOverrides,
      },
      null,
      2,
    ),
  );
  run("bun", ["install"], reactFreeDir);

  const reactFreeReactDirs = findPhysicalPackageDirs(path.join(reactFreeDir, "node_modules"), "react");
  if (reactFreeReactDirs.size !== 0) {
    throw new Error(
      `React-free consumer unexpectedly installed react (${Array.from(reactFreeReactDirs).join(", ")})`,
    );
  }
  const reactFreeHotkeys = findPhysicalPackageDirs(
    path.join(reactFreeDir, "node_modules"),
    "@shaulavo/hotkeys",
  );
  if (reactFreeHotkeys.size !== 1) {
    throw new Error(
      `Expected 1 deduplicated @shaulavo/hotkeys in React-free fixture, got ${reactFreeHotkeys.size}`,
    );
  }
  run(
    "bun",
    [
      "-e",
      `import * as tokens from "@shaulavo/workbench-tokens";
       import * as core from "@shaulavo/workbench-core";
       import * as icons from "@shaulavo/workbench-icons";
       import { existsSync } from "node:fs";
       import { fileURLToPath } from "node:url";
       if (!tokens.parseCssColor || !core.resolveActivationFocus || !core.createReplayGate) process.exit(1);
       if (icons.resolveFileIconName("CLAUDE.md") !== "claude") process.exit(1);
       for (const css of ${JSON.stringify(REQUIRED_TOKEN_CSS_EXPORTS)}) {
         const resolved = fileURLToPath(import.meta.resolve(css));
         if (!existsSync(resolved)) throw new Error("Missing CSS export: " + css);
       }
       console.log("react-free-and-css-exports-ok");`,
    ],
    reactFreeDir,
  );

  const rootManifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    readonly workspaces: { readonly catalog: Readonly<Record<string, string>> };
  };
  const catalog = rootManifest.workspaces.catalog;
  const catalogPin = (name: string): string => {
    const version = catalog[name];
    if (!version) throw new Error(`Missing root catalog pin for ${name}`);
    return version;
  };

  // Fixture B: Bare Sprockt-like consumer (editor root without @dnd-kit/*, diff, markdown, or lsp peers).
  writeFileSync(
    path.join(bareSprocktDir, "package.json"),
    JSON.stringify(
      {
        name: "pack-consumer-bare-sprockt",
        private: true,
        type: "module",
        dependencies: {
          ...allOverrides,
          "@base-ui/react": catalogPin("@base-ui/react"),
          "@shaulavo/hotkeys": catalogPin("@shaulavo/hotkeys"),
          "@singapore-editor/core": catalogPin("@singapore-editor/core"),
          "@singapore-editor/find": catalogPin("@singapore-editor/find"),
          "@singapore-editor/gutters": catalogPin("@singapore-editor/gutters"),
          "@singapore-editor/highlighting": catalogPin("@singapore-editor/highlighting"),
          "@singapore-editor/plugin-ui": catalogPin("@singapore-editor/plugin-ui"),
          "@singapore-editor/react": catalogPin("@singapore-editor/react"),
          "ghostty-webgpu": catalogPin("ghostty-webgpu"),
          react: catalogPin("react"),
          "react-dom": catalogPin("react-dom"),
        },
        overrides: allOverrides,
      },
      null,
      2,
    ),
  );
  run("bun", ["install", "--linker=isolated"], bareSprocktDir);

  for (const absentOptional of [
    "@dnd-kit/core",
    "@dnd-kit/sortable",
    "@dnd-kit/utilities",
    "@singapore-editor/lsp",
    "@singapore-editor/lsp-plugin",
    "@singapore-editor/markdown",
    "@singapore-editor/minimap",
    "@singapore-editor/scope-lines",
  ]) {
    const dirs = findPhysicalPackageDirs(path.join(bareSprocktDir, "node_modules"), absentOptional);
    if (dirs.size !== 0) {
      throw new Error(`Bare Sprockt fixture unexpectedly installed optional peer ${absentOptional}`);
    }
  }
  // Under --linker=isolated, @singapore-editor/diff stays private inside @singapore-editor/highlighting and is absent at top level.
  if (existsSync(path.join(bareSprocktDir, "node_modules/@singapore-editor/diff"))) {
    throw new Error("Bare Sprockt fixture unexpectedly exposed optional peer @singapore-editor/diff");
  }

  writeFileSync(
    path.join(bareSprocktDir, "entry.ts"),
    [
      'import "@shaulavo/workbench-editor/editor.css";',
      "import {",
      "  EditorWorkbench,",
      "  EditorView,",
      "  EditorTabBar,",
      "  buildWorkbenchEditorTheme,",
      "  capOverscrollTop,",
      "  createWorkbenchEditorPlugins,",
      "  documentFeatureTier,",
      "  languageIdForPath,",
      '} from "@shaulavo/workbench-editor";',
      "export const bareEditorExports = {",
      "  EditorWorkbench,",
      "  EditorView,",
      "  EditorTabBar,",
      "  buildWorkbenchEditorTheme,",
      "  capOverscrollTop,",
      "  createWorkbenchEditorPlugins,",
      "  documentFeatureTier,",
      "  languageIdForPath,",
      "};",
      "",
    ].join("\n"),
  );
  run(
    "bun",
    [
      "-e",
      `const result = await Bun.build({
         entrypoints: ["./entry.ts"],
         target: "browser",
         outdir: "./dist",
         format: "esm",
       });
       if (!result.success) {
         console.error(result.logs);
         process.exit(1);
       }
       const jsOut = result.outputs.find((o) => o.path.endsWith(".js"));
       const cssOut = result.outputs.find((o) => o.path.endsWith(".css"));
       if (!jsOut || !cssOut) throw new Error("Expected bundled JS and CSS outputs for bare Sprockt fixture");
       const builtText = await jsOut.text();
       if (!builtText.includes("wb-editor-view")) throw new Error("Bare bundle missing EditorView output");
       const { bareEditorExports } = await import(jsOut.path);
       if (bareEditorExports.languageIdForPath("src/App.tsx") !== "tsx") process.exit(1);
       if (typeof bareEditorExports.EditorWorkbench !== "function") process.exit(1);
       if (typeof bareEditorExports.EditorView !== "function") process.exit(1);
       if (typeof bareEditorExports.EditorTabBar !== "function") process.exit(1);
       console.log("bare-sprockt-editor-root-bundle-ok");`,
    ],
    bareSprocktDir,
  );

  // Fixture C: Full Fregat-like peer consumer (all 8 packages + all editor subpaths).
  writeFileSync(
    path.join(fullPeerDir, "package.json"),
    JSON.stringify(
      {
        name: "pack-consumer-full-peers",
        private: true,
        type: "module",
        dependencies: {
          ...allOverrides,
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
          "@singapore-editor/minimap": catalogPin("@singapore-editor/minimap"),
          "@singapore-editor/plugin-ui": catalogPin("@singapore-editor/plugin-ui"),
          "@singapore-editor/react": catalogPin("@singapore-editor/react"),
          "@singapore-editor/scope-lines": catalogPin("@singapore-editor/scope-lines"),
          "ghostty-webgpu": catalogPin("ghostty-webgpu"),
          react: catalogPin("react"),
          "react-dom": catalogPin("react-dom"),
        },
        overrides: allOverrides,
      },
      null,
      2,
    ),
  );
  run("bun", ["install"], fullPeerDir);

  for (const peerPkg of ["@shaulavo/hotkeys", "@base-ui/react", "ghostty-webgpu", "@singapore-editor/core"]) {
    const dirs = findPhysicalPackageDirs(path.join(fullPeerDir, "node_modules"), peerPkg);
    if (dirs.size !== 1) {
      throw new Error(`Expected 1 deduplicated ${peerPkg} in full-peer fixture, got ${dirs.size}`);
    }
  }

  const tsxTranspiler = new Bun.Transpiler({ loader: "tsx" });
  const jsTranspiler = new Bun.Transpiler({ loader: "js" });
  const scanImportsInFile = (filePath: string): Set<string> => {
    const transpiler = filePath.endsWith(".js") ? jsTranspiler : tsxTranspiler;
    return new Set(transpiler.scanImports(readFileSync(filePath, "utf8")).map((item) => item.path));
  };

  for (const [label, relPath, mustImportReact] of [
    ["@shaulavo/workbench-core root", "node_modules/@shaulavo/workbench-core/dist/index.js", false],
    ["@shaulavo/workbench-core/react", "node_modules/@shaulavo/workbench-core/dist/react/index.js", true],
    ["@shaulavo/workbench-icons root", "node_modules/@shaulavo/workbench-icons/dist/index.js", false],
    ["@shaulavo/workbench-icons/react", "node_modules/@shaulavo/workbench-icons/dist/react/index.js", true],
    ["@shaulavo/workbench-ui root", "node_modules/@shaulavo/workbench-ui/dist/index.js", true],
    ["@shaulavo/workbench-tree root", "node_modules/@shaulavo/workbench-tree/dist/index.js", false],
    ["@shaulavo/workbench-tree/react", "node_modules/@shaulavo/workbench-tree/dist/react/index.js", true],
    ["@shaulavo/workbench-terminal root", "node_modules/@shaulavo/workbench-terminal/dist/index.js", true],
    ["@shaulavo/workbench-preview root", "node_modules/@shaulavo/workbench-preview/dist/index.js", true],
    ["@shaulavo/workbench-editor root", "node_modules/@shaulavo/workbench-editor/dist/index.js", true],
    [
      "@shaulavo/workbench-editor/groups",
      "node_modules/@shaulavo/workbench-editor/dist/groups/index.js",
      true,
    ],
    ["@shaulavo/workbench-editor/lsp", "node_modules/@shaulavo/workbench-editor/dist/lsp/index.js", true],
    [
      "@shaulavo/workbench-editor/composer",
      "node_modules/@shaulavo/workbench-editor/dist/composer/index.js",
      true,
    ],
    ["@shaulavo/workbench-editor/diff", "node_modules/@shaulavo/workbench-editor/dist/diff/index.js", true],
  ] as const) {
    const imported = scanImportsInFile(path.join(fullPeerDir, relPath));
    const importsReact =
      imported.has("react") || imported.has("react/jsx-runtime") || imported.has("react/jsx-dev-runtime");
    if (mustImportReact && !importsReact) {
      throw new Error(`${label} must keep react externalized`);
    }
    if (!mustImportReact && importsReact) {
      throw new Error(`${label} must not import react`);
    }
  }

  const editorRootImports = scanImportsInFile(
    path.join(fullPeerDir, "node_modules/@shaulavo/workbench-editor/dist/index.js"),
  );
  for (const forbidden of [
    "@dnd-kit/core",
    "@singapore-editor/diff",
    "@singapore-editor/markdown",
    "@singapore-editor/lsp-plugin",
  ]) {
    if (editorRootImports.has(forbidden)) {
      throw new Error(`@shaulavo/workbench-editor root must not import optional subpath dep ${forbidden}`);
    }
  }

  const groupsImports = scanImportsInFile(
    path.join(fullPeerDir, "node_modules/@shaulavo/workbench-editor/dist/groups/index.js"),
  );
  if (!groupsImports.has("@dnd-kit/core") || !groupsImports.has("@dnd-kit/sortable")) {
    throw new Error(
      "@shaulavo/workbench-editor/groups must keep @dnd-kit/core and @dnd-kit/sortable externalized",
    );
  }

  const terminalDistImports = scanImportsInFile(
    path.join(fullPeerDir, "node_modules/@shaulavo/workbench-terminal/dist/index.js"),
  );
  if (!terminalDistImports.has("ghostty-webgpu") || !terminalDistImports.has("ghostty-webgpu/hotkeys")) {
    throw new Error(
      "@shaulavo/workbench-terminal must keep ghostty-webgpu and ghostty-webgpu/hotkeys externalized",
    );
  }
  const previewDistImports = scanImportsInFile(
    path.join(fullPeerDir, "node_modules/@shaulavo/workbench-preview/dist/index.js"),
  );
  if (
    Array.from(previewDistImports).some(
      (spec) => spec === "ghostty-webgpu" || spec.startsWith("ghostty-webgpu/"),
    )
  ) {
    throw new Error("@shaulavo/workbench-preview must not import ghostty-webgpu");
  }

  writeFileSync(
    path.join(fullPeerDir, "full-editor-entry.ts"),
    [
      'import "@shaulavo/workbench-ui/ui.css";',
      'import "@shaulavo/workbench-tree/tree.css";',
      'import "@shaulavo/workbench-terminal/terminal.css";',
      'import "@shaulavo/workbench-preview/preview.css";',
      'import "@shaulavo/workbench-editor/editor.css";',
      'import * as editorRoot from "@shaulavo/workbench-editor";',
      'import * as editorGroups from "@shaulavo/workbench-editor/groups";',
      'import * as editorLsp from "@shaulavo/workbench-editor/lsp";',
      'import * as editorComposer from "@shaulavo/workbench-editor/composer";',
      'import * as editorDiff from "@shaulavo/workbench-editor/diff";',
      "export const allEditorSubpaths = { editorRoot, editorGroups, editorLsp, editorComposer, editorDiff };",
      "",
    ].join("\n"),
  );

  run(
    "bun",
    [
      "-e",
      `import { createRequire } from "node:module";
       import * as coreReact from "@shaulavo/workbench-core/react";
       import * as iconsReact from "@shaulavo/workbench-icons/react";
       import * as ui from "@shaulavo/workbench-ui";
       import * as tree from "@shaulavo/workbench-tree";
       import * as treeReact from "@shaulavo/workbench-tree/react";
       import * as terminal from "@shaulavo/workbench-terminal";
       import * as preview from "@shaulavo/workbench-preview";
       const req = createRequire(process.cwd() + "/package.json");
       for (const name of [
         "@shaulavo/workbench-tokens",
         "@shaulavo/workbench-core",
         "@shaulavo/workbench-icons",
         "@shaulavo/workbench-ui",
         "@shaulavo/workbench-tree",
         "@shaulavo/workbench-terminal",
         "@shaulavo/workbench-preview",
         "@shaulavo/workbench-editor",
       ]) {
         const resolved = req.resolve(name);
         if (!resolved.includes("/dist/")) {
           throw new Error("createRequire.resolve did not land in dist for " + name + ": " + resolved);
         }
       }
       if (!coreReact.useSubscribable || !iconsReact.FileTypeIcon || !ui.WorkbenchShell || !ui.CommandPalette) process.exit(1);
       if (!tree.prepareFileTreeInput || !tree.FileTreeModel || !treeReact.FileTreeView) process.exit(1);
       if (!terminal.TerminalPanel || !terminal.TerminalView || !terminal.TerminalAccessoryBar) process.exit(1);
       if (!preview.PreviewPane || !preview.createPreviewBridgeController || !preview.createBridgelessPreviewController) process.exit(1);
       const build = await Bun.build({
         entrypoints: ["./full-editor-entry.ts"],
         target: "browser",
         outdir: "./dist",
         format: "esm",
       });
       if (!build.success) {
         console.error(build.logs);
         process.exit(1);
       }
       const jsOut = build.outputs.find((o) => o.path.endsWith(".js"));
       const cssOut = build.outputs.find((o) => o.path.endsWith(".css"));
       if (!jsOut || !cssOut) throw new Error("Full-peer editor bundle missing JS or CSS output");
       if (typeof globalThis.document === "undefined") {
         globalThis.document = {
           createElement: () => ({ innerHTML: "", textContent: "" }),
         };
       }
       const { allEditorSubpaths } = await import(jsOut.path);
       if (allEditorSubpaths.editorRoot.languageIdForPath("src/App.tsx") !== "tsx") process.exit(1);
       if (typeof allEditorSubpaths.editorGroups.EditorGroupLayout !== "function") process.exit(1);
       if (typeof allEditorSubpaths.editorGroups.applyTabPlacement !== "function") process.exit(1);
       if (typeof allEditorSubpaths.editorLsp.DiagnosticPeek !== "function") process.exit(1);
       if (typeof allEditorSubpaths.editorLsp.diagnosticPeekPlacement !== "function") process.exit(1);
       if (typeof allEditorSubpaths.editorComposer.MarkdownComposer !== "function") process.exit(1);
       const tok = allEditorSubpaths.editorComposer.formatMentionToken("docs/closing ] bracket.md");
       if (allEditorSubpaths.editorComposer.findMentionRanges(tok)[0]?.path !== "docs/closing ] bracket.md") {
         throw new Error("Mention round-trip failed in packed bundle");
       }
       if (typeof allEditorSubpaths.editorDiff.DiffEditorView !== "function") process.exit(1);
       console.log("full-peer-8-packages-ok");`,
    ],
    fullPeerDir,
  );

  console.log(
    "pack-check: ok (8 packages: react-free + bare-sprockt + full-peer fixtures, all editor subpaths & CSS exports, single @shaulavo/hotkeys, @base-ui/react, ghostty-webgpu & @singapore-editor/core, LICENSE/NOTICE/THIRD_PARTY_NOTICES verified)",
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
