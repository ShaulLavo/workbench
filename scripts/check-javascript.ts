import { readdirSync } from "node:fs";
import path from "node:path";

const ROOTS = ["packages", "apps", "scripts"];
const IGNORED = new Set(["node_modules", "dist", ".turbo", "playwright-report", "test-results"]);
const FORBIDDEN_EXT = /\.(?:js|mjs|cjs|jsx)$/i;

const violations: string[] = [];

function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (FORBIDDEN_EXT.test(entry.name)) {
      violations.push(path.relative(process.cwd(), full));
    }
  }
}

for (const root of ROOTS) {
  walk(path.resolve(process.cwd(), root));
}

if (violations.length > 0) {
  console.error("Hand-written JavaScript files are forbidden; use TypeScript:");
  for (const file of violations) console.error(`  - ${file}`);
  process.exit(1);
}

console.log("check-javascript: ok (0 JS source files)");
