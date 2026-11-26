import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  EXCLUDED_VSCODE_ICON_SOURCES,
  FILE_ICON_GLYPHS,
  FILE_ICON_MANIFEST,
} from "../packages/icons/src/index";

const ROOT = process.cwd();
const SCAN_DIRS = ["packages", "scripts", "apps"];
const IGNORED = new Set(["node_modules", "dist", ".turbo", "playwright-report", "test-results"]);
const FORBIDDEN_PATTERNS: readonly { readonly label: string; readonly re: RegExp }[] = [
  { label: "Apache-2.0 header", re: /\bApache-2\.0\b/i },
  { label: "LICENSE-pierre reference", re: /\bLICENSE-pierre\b/i },
  { label: "CC-BY license reference", re: /\bCC-BY(?:-4\.0)?\b/i },
  { label: "Pierre fork marker", re: /Modified for Platform from Pierre/i },
];
const ALLOWED_LICENSES = new Set(["MIT", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0"]);
const BUILD_ASSET_DEV_DEPS: Readonly<Record<string, readonly string[]>> = {
  "@shaulavo/workbench-icons": ["@pierre/vscode-icons", "@iconify-json/catppuccin", "simple-icons"],
};

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
    if (
      entry.name === "LICENSE" ||
      entry.name === "NOTICE" ||
      entry.name === "THIRD_PARTY_NOTICES.txt" ||
      entry.name === "license-check.ts"
    ) {
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

function checkDepLicense(pkgDir: string, pkgName: string, dep: string, kind: string): void {
  const depManifestPath = resolveNodeModuleManifest(pkgDir, dep);
  if (!depManifestPath) {
    violations.push(`${pkgName} ${kind} ${dep}: package.json not found in node_modules`);
    return;
  }
  const depManifest = JSON.parse(readFileSync(depManifestPath, "utf8")) as { readonly license?: string };
  if (!depManifest.license || !ALLOWED_LICENSES.has(depManifest.license)) {
    violations.push(
      `${pkgName} ${kind} ${dep}: license ${JSON.stringify(depManifest.license)} not in allowlist`,
    );
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
  const pkgName = manifest.name ?? path.relative(ROOT, pkgDir);
  if (manifest.license !== "MIT") {
    violations.push(`${path.relative(ROOT, manifestPath)}: license must be MIT, got ${manifest.license}`);
  }
  const deps = Object.keys(manifest.dependencies ?? {}).filter(
    (name) => !name.startsWith("@shaulavo/workbench-"),
  );
  for (const dep of deps) {
    checkDepLicense(pkgDir, pkgName, dep, "dependency");
  }
  const assetDeps = BUILD_ASSET_DEV_DEPS[pkgName] ?? [];
  for (const dep of assetDeps) {
    checkDepLicense(pkgDir, pkgName, dep, "build-asset devDependency");
  }
}

function checkIconManifest(): void {
  const excluded = new Set<string>(EXCLUDED_VSCODE_ICON_SOURCES);
  const manifestKeys = new Set(Object.keys(FILE_ICON_MANIFEST));
  const generatedKeys = new Set(Object.keys(FILE_ICON_GLYPHS));

  for (const key of generatedKeys) {
    if (!manifestKeys.has(key)) {
      violations.push(`packages/icons: generated glyph "${key}" is missing from approved FILE_ICON_MANIFEST`);
    }
  }
  for (const key of manifestKeys) {
    if (!generatedKeys.has(key)) {
      violations.push(`packages/icons: approved glyph "${key}" is missing from generated FILE_ICON_GLYPHS`);
    }
  }
  for (const [name, spec] of Object.entries(FILE_ICON_MANIFEST)) {
    if (spec.source === "vscode-icons" && excluded.has(spec.sourceName)) {
      violations.push(
        `packages/icons: forbidden @pierre/vscode-icons glyph "${spec.sourceName}" in manifest (${name})`,
      );
    }
    if (!ALLOWED_LICENSES.has(spec.license)) {
      violations.push(`packages/icons: glyph "${name}" has disallowed license ${spec.license}`);
    }
  }
  if (FILE_ICON_MANIFEST.claude.source === "vscode-icons") {
    violations.push("packages/icons: claude glyph must not be sourced from @pierre/vscode-icons");
  }
  const noticesPath = path.join(ROOT, "packages/icons/THIRD_PARTY_NOTICES.txt");
  if (!existsSync(noticesPath)) {
    violations.push("packages/icons/THIRD_PARTY_NOTICES.txt is missing");
  } else {
    const notices = readFileSync(noticesPath, "utf8");
    for (const required of ["@pierre/vscode-icons", "@iconify-json/catppuccin", "simple-icons"]) {
      if (!notices.includes(required)) {
        violations.push(`packages/icons/THIRD_PARTY_NOTICES.txt missing attribution for ${required}`);
      }
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

checkIconManifest();

if (violations.length > 0) {
  console.error("license-check failed:");
  for (const item of violations) console.error(`  - ${item}`);
  process.exit(1);
}

console.log(
  `license-check: ok (100% MIT/CC0 provenance verified across ${Object.keys(FILE_ICON_MANIFEST).length} approved icon glyphs)`,
);
