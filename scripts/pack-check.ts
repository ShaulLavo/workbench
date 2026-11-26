import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const PACKAGES = ["packages/tokens", "packages/core"] as const;

function run(cmd: string, args: readonly string[], cwd: string): string {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Command failed (${cmd} ${args.join(" ")}):\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "workbench-pack-check-"));
const tarDir = path.join(tempRoot, "tarballs");
const consumerDir = path.join(tempRoot, "consumer");
mkdirSync(tarDir, { recursive: true });
mkdirSync(consumerDir, { recursive: true });

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

    // Inspect tarball entries for LICENSE, NOTICE, and dist files.
    const listing = run("tar", ["-tzf", tgzPath], tarDir).split("\n");
    for (const required of ["package/LICENSE", "package/NOTICE", "package/package.json"]) {
      if (!listing.includes(required)) {
        throw new Error(`${manifest.name} tarball missing ${required}`);
      }
    }
    const bundledReact = listing.some((file) => /node_modules\/react\b/.test(file));
    if (bundledReact) {
      throw new Error(`${manifest.name} tarball unexpectedly bundled react`);
    }
  }

  // Install packed tarballs into a clean isolated consumer (bare install: zero Singapore/Ghostty).
  writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify(
      {
        name: "pack-consumer-check",
        private: true,
        type: "module",
        dependencies: {
          "@shaulavo/hotkeys": "0.0.4",
          "@shaulavo/workbench-tokens": `file:${tarballs.get("@shaulavo/workbench-tokens")}`,
          "@shaulavo/workbench-core": `file:${tarballs.get("@shaulavo/workbench-core")}`,
          react: "19.3.1",
        },
        overrides: {
          "@shaulavo/workbench-tokens": `file:${tarballs.get("@shaulavo/workbench-tokens")}`,
          "@shaulavo/workbench-core": `file:${tarballs.get("@shaulavo/workbench-core")}`,
        },
      },
      null,
      2,
    ),
  );

  run("bun", ["install"], consumerDir);

  // Verify externalized ESM imports work cleanly without pulling React into root core entry.
  const coreEntry = readFileSync(
    path.join(consumerDir, "node_modules/@shaulavo/workbench-core/dist/index.js"),
    "utf8",
  );
  if (/from\s+["']react["']/.test(coreEntry)) {
    throw new Error("@shaulavo/workbench-core root entry must not import react");
  }
  const coreReactEntry = readFileSync(
    path.join(consumerDir, "node_modules/@shaulavo/workbench-core/dist/react/index.js"),
    "utf8",
  );
  if (!/from\s+["']react["']/.test(coreReactEntry)) {
    throw new Error("@shaulavo/workbench-core/react must keep react externalized");
  }
  const tokensCss = path.join(consumerDir, "node_modules/@shaulavo/workbench-tokens/dist/tokens.css");
  if (!existsSync(tokensCss)) {
    throw new Error("@shaulavo/workbench-tokens/dist/tokens.css missing in packed install");
  }

  run(
    "bun",
    [
      "-e",
      'import * as tokens from "@shaulavo/workbench-tokens"; import * as core from "@shaulavo/workbench-core"; import * as coreReact from "@shaulavo/workbench-core/react"; if (!tokens.parseCssColor || !core.resolveActivationFocus || !coreReact.useSubscribable) process.exit(1); console.log("packed-imports-ok");',
    ],
    consumerDir,
  );

  console.log("pack-check: ok (tarballs, LICENSE/NOTICE, externalized peers, bare install verified)");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
