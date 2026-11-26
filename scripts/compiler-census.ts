import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * Verifies every shared package and harness source file compiles cleanly under oxc-transform-react's
 * React Compiler with zero unapproved bailouts or `'use no memo'` directives.
 * Any justified opt-out (e.g. imperative Ghostty WASM canvas host wrapper) must be allowlisted below.
 */
const ALLOWED_BAILOUTS: ReadonlyMap<string, string> = new Map([
  [
    "packages/ui/src/components/virtual-list.tsx",
    "TanStack useVirtualizer returns a mutable virtualizer instance read on every render",
  ],
  [
    "packages/tree/src/react/tree-viewport.tsx",
    "TanStack useVirtualizer returns a mutable virtualizer instance read on every render",
  ],
]);

const ROOT = process.cwd();
const SCAN_ROOTS = ["packages", "apps/harness/src"];
const IGNORED = new Set(["node_modules", "dist", ".turbo", "tests", "e2e", "scripts"]);
const BAILOUT_RE = /['"]use no memo['"]/;

const require = createRequire(path.join(ROOT, "package.json"));
const { transformSync } = require("oxc-transform-react") as {
  readonly transformSync: (
    filename: string,
    sourceText: string,
    options: {
      readonly jsx: { readonly runtime: "automatic"; readonly importSource: "react" };
      readonly reactCompiler: { readonly panicThreshold?: "all_errors" };
    },
  ) => { readonly code: string; readonly errors: readonly { readonly message: string }[] };
};

const violations: string[] = [];
let scanned = 0;

function walk(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (
      !/\.(?:ts|tsx)$/.test(entry.name) ||
      entry.name.endsWith(".test.ts") ||
      entry.name.endsWith(".test.tsx")
    ) {
      continue;
    }
    const rel = path.relative(ROOT, full);
    const content = readFileSync(full, "utf8");
    scanned += 1;

    if (BAILOUT_RE.test(content) && !ALLOWED_BAILOUTS.has(rel)) {
      violations.push(`${rel}: unapproved 'use no memo' directive`);
      continue;
    }

    const checked = transformSync(full, content, {
      jsx: { runtime: "automatic", importSource: "react" },
      reactCompiler: { panicThreshold: "all_errors" },
    });
    if (checked.errors.length > 0 && !ALLOWED_BAILOUTS.has(rel)) {
      for (const err of checked.errors) {
        violations.push(`${rel}: React Compiler diagnostic: ${err.message}`);
      }
    }
  }
}

for (const root of SCAN_ROOTS) walk(path.join(ROOT, root));

if (violations.length > 0) {
  console.error("compiler-census failed:");
  for (const item of violations) console.error(`  - ${item}`);
  process.exit(1);
}

console.log(
  `compiler-census: ok (${scanned} files compiled, 0 unapproved diagnostics or bailouts, ${ALLOWED_BAILOUTS.size} allowlisted)`,
);
