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
const PACKAGES = ["packages/tokens", "packages/core"] as const;
const REQUIRED_TOKEN_CSS_EXPORTS = [
  "@shaulavo/workbench-tokens/tokens.css",
  "@shaulavo/workbench-tokens/reset.css",
  "@shaulavo/workbench-tokens/tailwind-bridge.css",
  "@shaulavo/workbench-tokens/themes/fregat.css",
  "@shaulavo/workbench-tokens/themes/sprockt.css",
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
    for (const required of ["package/LICENSE", "package/NOTICE", "package/package.json"]) {
      if (!listing.includes(required)) {
        throw new Error(`${manifest.name} tarball missing ${required}`);
      }
    }
    if (listing.some((file) => /node_modules\/react\b/.test(file))) {
      throw new Error(`${manifest.name} tarball unexpectedly bundled react`);
    }
  }

  const overrides = {
    "@shaulavo/workbench-tokens": `file:${tarballs.get("@shaulavo/workbench-tokens")}`,
    "@shaulavo/workbench-core": `file:${tarballs.get("@shaulavo/workbench-core")}`,
  };

  // Fixture A: React-free root consumer (NO react, NO explicit @shaulavo/hotkeys).
  writeFileSync(
    path.join(reactFreeDir, "package.json"),
    JSON.stringify(
      {
        name: "pack-consumer-react-free",
        private: true,
        type: "module",
        dependencies: overrides,
        overrides,
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
       import { existsSync } from "node:fs";
       import { fileURLToPath } from "node:url";
       if (!tokens.parseCssColor || !core.resolveActivationFocus || !core.createReplayGate) process.exit(1);
       for (const css of ${JSON.stringify(REQUIRED_TOKEN_CSS_EXPORTS)}) {
         const resolved = fileURLToPath(import.meta.resolve(css));
         if (!existsSync(resolved)) throw new Error("Missing CSS export: " + css);
       }
       console.log("react-free-and-css-exports-ok");`,
    ],
    reactFreeDir,
  );

  // Fixture B: Full React 19 + explicit @shaulavo/hotkeys peer consumer.
  writeFileSync(
    path.join(fullPeerDir, "package.json"),
    JSON.stringify(
      {
        name: "pack-consumer-full-peers",
        private: true,
        type: "module",
        dependencies: {
          ...overrides,
          "@shaulavo/hotkeys": "0.0.4",
          react: "19.3.1",
          "react-dom": "19.3.1",
        },
        overrides,
      },
      null,
      2,
    ),
  );
  run("bun", ["install"], fullPeerDir);

  const fullHotkeys = findPhysicalPackageDirs(path.join(fullPeerDir, "node_modules"), "@shaulavo/hotkeys");
  if (fullHotkeys.size !== 1) {
    throw new Error(
      `Expected 1 deduplicated @shaulavo/hotkeys in full-peer fixture, got ${fullHotkeys.size}`,
    );
  }
  const coreEntry = readFileSync(
    path.join(fullPeerDir, "node_modules/@shaulavo/workbench-core/dist/index.js"),
    "utf8",
  );
  if (/from\s+["']react["']/.test(coreEntry)) {
    throw new Error("@shaulavo/workbench-core root entry must not import react");
  }
  const coreReactEntry = readFileSync(
    path.join(fullPeerDir, "node_modules/@shaulavo/workbench-core/dist/react/index.js"),
    "utf8",
  );
  if (!/from\s+["']react["']/.test(coreReactEntry)) {
    throw new Error("@shaulavo/workbench-core/react must keep react externalized");
  }

  run(
    "bun",
    [
      "-e",
      'import * as coreReact from "@shaulavo/workbench-core/react"; if (!coreReact.useSubscribable || !coreReact.useWorkbenchTheme) process.exit(1); console.log("full-peer-react-ok");',
    ],
    fullPeerDir,
  );

  console.log(
    "pack-check: ok (react-free + full-peer fixtures, CSS subpaths, single @shaulavo/hotkeys, LICENSE/NOTICE verified)",
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
