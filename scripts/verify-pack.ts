import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const tempDir = mkdtempSync(path.join(os.tmpdir(), "workbench-verify-pack-"));

function runInherit(cmd: string, args: readonly string[]): void {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Command failed (${cmd} ${args.join(" ")}) with status ${result.status}`);
  }
}

try {
  runInherit("bun", ["scripts/pack-release.ts", "--out-dir", tempDir, "--allow-dirty"]);
  const manifestPath = path.join(tempDir, "candidate-manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { readonly tarballFile: string };
  const tarballPath = path.join(tempDir, manifest.tarballFile);
  const recordPath = path.join(tempDir, "pack-check-record.json");
  runInherit("bun", [
    "scripts/pack-check.ts",
    "--tarball",
    tarballPath,
    "--manifest",
    manifestPath,
    "--record",
    recordPath,
  ]);
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
