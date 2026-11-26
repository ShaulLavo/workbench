import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Verifies no unapproved `'use no memo'` bailouts exist in shared packages.
 * Any justified opt-out (e.g. imperative Ghostty WASM canvas host wrapper) must be listed below
 * with a reason.
 */
const ALLOWED_BAILOUTS: ReadonlyMap<string, string> = new Map();

const ROOT = process.cwd();
const IGNORED = new Set(["node_modules", "dist", ".turbo"]);
const BAILOUT_RE = /['"]use no memo['"]/;
const violations: string[] = [];

function walk(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!/\.(?:ts|tsx)$/.test(entry.name)) continue;
    const rel = path.relative(ROOT, full);
    const content = readFileSync(full, "utf8");
    if (BAILOUT_RE.test(content) && !ALLOWED_BAILOUTS.has(rel)) {
      violations.push(`${rel}: unapproved 'use no memo' directive`);
    }
  }
}

walk(path.join(ROOT, "packages"));

if (violations.length > 0) {
  console.error("compiler-census failed:");
  for (const item of violations) console.error(`  - ${item}`);
  process.exit(1);
}

console.log(`compiler-census: ok (0 unapproved bailouts, ${ALLOWED_BAILOUTS.size} allowlisted)`);
