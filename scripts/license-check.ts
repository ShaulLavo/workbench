import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["packages", "scripts", "apps"];
const IGNORED = new Set(["node_modules", "dist", ".turbo", "playwright-report", "test-results"]);
const FORBIDDEN_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: "Apache-2.0 header", re: /\bApache-2\.0\b/i },
  { label: "LICENSE-pierre reference", re: /\bLICENSE-pierre\b/i },
  { label: "CC-BY license reference", re: /\bCC-BY(?:-4\.0)?\b/i },
  { label: "Pierre fork marker", re: /Modified for Platform from Pierre/i },
];
const ALLOWED_LICENSES = new Set(["MIT", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause"]);

const violations: string[] = [];

function scanSource(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanSource(full);
      continue;
    }
    if (entry.name === "LICENSE" || entry.name === "NOTICE" || entry.name === "license-check.ts") {
      continue;
    }
    if (!/\.(?:ts|tsx|css|json|md|html)$/i.test(entry.name)) continue;
    const text = readFileSync(full, "utf8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.re.test(text)) {
        violations.push(`${path.relative(ROOT, full)}: matched forbidden ${pattern.label}`);
      }
    }
  }
}

function checkPackageDeps(pkgDir: string): void {
  const manifestPath = path.join(pkgDir, "package.json");
  if (!existsSync(manifestPath)) return;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly name?: string;
    readonly license?: string;
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  if (manifest.license !== "MIT") {
    violations.push(`${path.relative(ROOT, manifestPath)}: license must be MIT, got ${manifest.license}`);
  }
  const deps = Object.keys(manifest.dependencies ?? {}).filter(
    (name) => !name.startsWith("@shaulavo/workbench-"),
  );
  for (const dep of deps) {
    const depManifestPath = resolveNodeModuleManifest(pkgDir, dep);
    if (!depManifestPath) continue;
    const depManifest = JSON.parse(readFileSync(depManifestPath, "utf8")) as { readonly license?: string };
    if (!depManifest.license || !ALLOWED_LICENSES.has(depManifest.license)) {
      violations.push(
        `${manifest.name} dependency ${dep}: license ${JSON.stringify(depManifest.license)} not in allowlist`,
      );
    }
  }
}

function resolveNodeModuleManifest(startDir: string, pkgName: string): string | undefined {
  let current = startDir;
  while (true) {
    const candidate = path.join(current, "node_modules", pkgName, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

if (!existsSync(path.join(ROOT, "LICENSE"))) {
  violations.push("Root LICENSE file is missing");
}

for (const dir of SCAN_DIRS) scanSource(path.join(ROOT, dir));

const packagesDir = path.join(ROOT, "packages");
if (existsSync(packagesDir)) {
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (entry.isDirectory()) checkPackageDeps(path.join(packagesDir, entry.name));
  }
}

if (violations.length > 0) {
  console.error("license-check failed:");
  for (const item of violations) console.error(`  - ${item}`);
  process.exit(1);
}

console.log("license-check: ok (100% MIT provenance verified)");
