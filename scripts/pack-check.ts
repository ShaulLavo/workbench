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
const PACKAGES = ["packages/tokens", "packages/core", "packages/icons", "packages/ui"] as const;
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
const fullPeerDir = path.join(tempRoot, "consumer-full-peers");
mkdirSync(tarDir, { recursive: true });
mkdirSync(reactFreeDir, { recursive: true });
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
    if (listing.some((file) => /node_modules\/(?:react|@base-ui\/react)\b/.test(file))) {
      throw new Error(`${manifest.name} tarball unexpectedly bundled react or @base-ui/react`);
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

  // Fixture B: Full React 19 + @base-ui/react + @shaulavo/hotkeys peer consumer.
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
          "@shaulavo/hotkeys": "0.0.4",
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

  for (const peerPkg of ["@shaulavo/hotkeys", "@base-ui/react"]) {
    const dirs = findPhysicalPackageDirs(path.join(fullPeerDir, "node_modules"), peerPkg);
    if (dirs.size !== 1) {
      throw new Error(`Expected 1 deduplicated ${peerPkg} in full-peer fixture, got ${dirs.size}`);
    }
  }

  for (const [label, relPath, mustImportReact] of [
    ["@shaulavo/workbench-core root", "node_modules/@shaulavo/workbench-core/dist/index.js", false],
    ["@shaulavo/workbench-core/react", "node_modules/@shaulavo/workbench-core/dist/react/index.js", true],
    ["@shaulavo/workbench-icons root", "node_modules/@shaulavo/workbench-icons/dist/index.js", false],
    ["@shaulavo/workbench-icons/react", "node_modules/@shaulavo/workbench-icons/dist/react/index.js", true],
    ["@shaulavo/workbench-ui root", "node_modules/@shaulavo/workbench-ui/dist/index.js", true],
  ] as const) {
    const content = readFileSync(path.join(fullPeerDir, relPath), "utf8");
    const importsReact = /from\s+["']react(?:\/jsx-runtime)?["']/.test(content);
    if (mustImportReact && !importsReact) {
      throw new Error(`${label} must keep react externalized`);
    }
    if (!mustImportReact && importsReact) {
      throw new Error(`${label} must not import react`);
    }
  }

  const uiEntry = readFileSync(
    path.join(fullPeerDir, "node_modules/@shaulavo/workbench-ui/dist/index.js"),
    "utf8",
  );
  const expectedBaseUiSubpaths = new Set<string>();
  const uiSrcDir = path.join(ROOT, "packages/ui/src/components");
  for (const file of readdirSync(uiSrcDir)) {
    if (!file.endsWith(".tsx") && !file.endsWith(".ts")) continue;
    const srcText = readFileSync(path.join(uiSrcDir, file), "utf8");
    for (const match of srcText.matchAll(/from\s+["'](@base-ui\/react\/[^"']+)["']/g)) {
      if (match[1]) expectedBaseUiSubpaths.add(match[1]);
    }
  }
  if (expectedBaseUiSubpaths.size === 0) {
    throw new Error("Expected @shaulavo/workbench-ui to import at least one @base-ui/react subpath");
  }
  for (const subpath of expectedBaseUiSubpaths) {
    const escaped = subpath.replaceAll("/", "\\/");
    if (!new RegExp(`from\\s+["']${escaped}["']`).test(uiEntry)) {
      throw new Error(`@shaulavo/workbench-ui bundled instead of externalizing ${subpath}`);
    }
  }

  run(
    "bun",
    [
      "-e",
      `import * as coreReact from "@shaulavo/workbench-core/react";
       import * as iconsReact from "@shaulavo/workbench-icons/react";
       import * as ui from "@shaulavo/workbench-ui";
       import { existsSync } from "node:fs";
       import { fileURLToPath } from "node:url";
       if (!coreReact.useSubscribable || !iconsReact.FileTypeIcon || !ui.WorkbenchShell || !ui.CommandPalette) process.exit(1);
       const uiCss = fileURLToPath(import.meta.resolve("@shaulavo/workbench-ui/ui.css"));
       if (!existsSync(uiCss)) throw new Error("Missing @shaulavo/workbench-ui/ui.css");
       console.log("full-peer-react-and-ui-ok");`,
    ],
    fullPeerDir,
  );

  console.log(
    "pack-check: ok (4 packages: react-free + full-peer fixtures, CSS subpaths, single @shaulavo/hotkeys & @base-ui/react, LICENSE/NOTICE/THIRD_PARTY_NOTICES verified)",
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
