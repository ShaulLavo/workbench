import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface CandidateManifest {
  readonly ciRunId: string | null;
  readonly ciRunAttempt: string | null;
  readonly workflowEvent: string | null;
  readonly gitCommit: string;
  readonly gitTree: string;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly tarballFile: string;
  readonly sha256: string;
  readonly dirty: boolean;
}

const ROOT = process.cwd();
const PKG_DIR = path.join(ROOT, "packages/workbench");

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

const outDirArg = argValue("--out-dir");
if (!outDirArg) {
  console.error("Usage: bun scripts/pack-release.ts --out-dir <dir> [--allow-dirty]");
  process.exit(1);
}
const allowDirty = process.argv.includes("--allow-dirty");
const outDir = path.resolve(ROOT, outDirArg);

const porcelain = run("git", ["status", "--porcelain"], ROOT);
const dirty = porcelain.length > 0;
if (dirty && !allowDirty) {
  throw new Error(
    "pack-release requires a clean working tree (pass --allow-dirty only for local verification runs):\n" +
      porcelain,
  );
}

const gitCommit = run("git", ["rev-parse", "HEAD"], ROOT);
const gitTree = run("git", ["rev-parse", "HEAD^{tree}"], ROOT);
const pkgManifest = JSON.parse(readFileSync(path.join(PKG_DIR, "package.json"), "utf8")) as {
  readonly name: string;
  readonly version: string;
};

// Always rebuild packages/workbench/dist fresh directly (bypassing Turbo cache).
rmSync(path.join(PKG_DIR, "dist"), { recursive: true, force: true });
run("bun", ["run", "--cwd", "packages/workbench", "build"], ROOT);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
run("bun", ["pm", "pack", "--destination", outDir, "--quiet"], PKG_DIR);

const tarballs = readdirSync(outDir).filter((file) => file.endsWith(".tgz"));
if (tarballs.length !== 1 || !tarballs[0]) {
  throw new Error(`Expected exactly 1 tarball in ${outDir}, found: ${tarballs.join(", ")}`);
}
const tarballFile = tarballs[0];
const tarballPath = path.join(outDir, tarballFile);
const sha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");

const manifest: CandidateManifest = {
  ciRunId: process.env.GITHUB_RUN_ID ?? null,
  ciRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  workflowEvent: process.env.GITHUB_EVENT_NAME ?? null,
  gitCommit,
  gitTree,
  packageName: pkgManifest.name,
  packageVersion: pkgManifest.version,
  tarballFile,
  sha256,
  dirty,
};

writeFileSync(path.join(outDir, "candidate-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  `pack-release: ok (${manifest.packageName}@${manifest.packageVersion} -> ${tarballFile}, sha256=${sha256.slice(0, 12)}, dirty=${dirty})`,
);
