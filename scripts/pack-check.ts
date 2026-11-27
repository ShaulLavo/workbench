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
          "@base-ui/react": "1.9.0",
          "@shaulavo/hotkeys": "0.0.4",
          "@singapore-editor/core": "0.2.13",
          "@singapore-editor/find": "0.2.13",
          "@singapore-editor/gutters": "0.2.13",
          "@singapore-editor/highlighting": "0.2.16",
          "@singapore-editor/plugin-ui": "0.2.13",
          "@singapore-editor/react": "0.2.13",
          "ghostty-webgpu": "0.3.34",
          react: "19.3.1",
          "react-dom": "19.3.1",
        },
        overrides: allOverrides,
      },
      null,
      2,
    ),
  );
  run("bun", ["install"], bareSprocktDir);

  for (const absentOptional of [
    "@dnd-kit/core",
    "@dnd-kit/sortable",
    "@singapore-editor/markdown",
    "@singapore-editor/lsp-plugin",
    "@singapore-editor/minimap",
    "@singapore-editor/scope-lines",
  ]) {
    const dirs = findPhysicalPackageDirs(path.join(bareSprocktDir, "node_modules"), absentOptional);
    if (dirs.size !== 0) {
      throw new Error(`Bare Sprockt fixture unexpectedly installed optional peer ${absentOptional}`);
    }
  }
  run(
    "bun",
    [
      "-e",
      `import { existsSync } from "node:fs";
       import { fileURLToPath } from "node:url";
       const rootEntry = fileURLToPath(import.meta.resolve("@shaulavo/workbench-editor"));
       const cssEntry = fileURLToPath(import.meta.resolve("@shaulavo/workbench-editor/editor.css"));
       if (!existsSync(rootEntry) || !existsSync(cssEntry)) process.exit(1);
       console.log("bare-sprockt-editor-root-ok");`,
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
          "@base-ui/react": "1.9.0",
          "@dnd-kit/core": "6.3.1",
          "@dnd-kit/sortable": "10.0.0",
          "@dnd-kit/utilities": "3.2.2",
          "@shaulavo/hotkeys": "0.0.4",
          "@singapore-editor/core": "0.2.13",
          "@singapore-editor/diff": "0.2.13",
          "@singapore-editor/find": "0.2.13",
          "@singapore-editor/gutters": "0.2.13",
          "@singapore-editor/highlighting": "0.2.16",
          "@singapore-editor/lsp": "0.2.13",
          "@singapore-editor/lsp-plugin": "0.2.16",
          "@singapore-editor/markdown": "0.2.13",
          "@singapore-editor/minimap": "0.2.13",
          "@singapore-editor/plugin-ui": "0.2.13",
          "@singapore-editor/react": "0.2.13",
          "@singapore-editor/scope-lines": "0.2.13",
          "ghostty-webgpu": "0.3.34",
          react: "19.3.1",
          "react-dom": "19.3.1",
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

  run(
    "bun",
    [
      "-e",
      `import * as coreReact from "@shaulavo/workbench-core/react";
       import * as iconsReact from "@shaulavo/workbench-icons/react";
       import * as ui from "@shaulavo/workbench-ui";
       import * as tree from "@shaulavo/workbench-tree";
       import * as treeReact from "@shaulavo/workbench-tree/react";
       import * as terminal from "@shaulavo/workbench-terminal";
       import * as preview from "@shaulavo/workbench-preview";
       import { existsSync } from "node:fs";
       import { fileURLToPath } from "node:url";
       if (!coreReact.useSubscribable || !iconsReact.FileTypeIcon || !ui.WorkbenchShell || !ui.CommandPalette) process.exit(1);
       if (!tree.prepareFileTreeInput || !tree.FileTreeModel || !treeReact.FileTreeView) process.exit(1);
       if (!terminal.TerminalPanel || !terminal.TerminalView || !terminal.TerminalAccessoryBar) process.exit(1);
       if (!preview.PreviewPane || !preview.createPreviewBridgeController || !preview.createBridgelessPreviewController) process.exit(1);
       for (const entry of [
         "@shaulavo/workbench-editor",
         "@shaulavo/workbench-editor/groups",
         "@shaulavo/workbench-editor/lsp",
         "@shaulavo/workbench-editor/composer",
         "@shaulavo/workbench-editor/diff",
       ]) {
         const resolved = fileURLToPath(import.meta.resolve(entry));
         if (!existsSync(resolved)) throw new Error("Missing editor subpath: " + entry);
       }
       for (const css of [
         "@shaulavo/workbench-ui/ui.css",
         "@shaulavo/workbench-tree/tree.css",
         "@shaulavo/workbench-terminal/terminal.css",
         "@shaulavo/workbench-preview/preview.css",
         "@shaulavo/workbench-editor/editor.css",
       ]) {
         const resolved = fileURLToPath(import.meta.resolve(css));
         if (!existsSync(resolved)) throw new Error("Missing CSS export: " + css);
       }
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
