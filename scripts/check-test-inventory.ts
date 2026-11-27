import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Locks the 8-package -> single-package unit test migration so no pre-consolidation suite
 * is silently dropped by Vitest globs or path edits.
 */
const REQUIRED_MIGRATED_SUITES: readonly {
  readonly legacyPath: string;
  readonly migratedPath: string;
}[] = [
  {
    legacyPath: "packages/core/src/tests/builder-contract-spike.test.ts",
    migratedPath: "packages/workbench/src/core/tests/builder-contract-spike.test.ts",
  },
  {
    legacyPath: "packages/core/src/tests/commands.test.ts",
    migratedPath: "packages/workbench/src/core/tests/commands.test.ts",
  },
  {
    legacyPath: "packages/core/src/tests/focus-policy.test.ts",
    migratedPath: "packages/workbench/src/core/tests/focus-policy.test.ts",
  },
  {
    legacyPath: "packages/core/src/tests/fregat-contract-spike.test.ts",
    migratedPath: "packages/workbench/src/core/tests/fregat-contract-spike.test.ts",
  },
  {
    legacyPath: "packages/core/src/tests/layout.test.ts",
    migratedPath: "packages/workbench/src/core/tests/layout.test.ts",
  },
  {
    legacyPath: "packages/core/src/tests/long-press.test.ts",
    migratedPath: "packages/workbench/src/core/tests/long-press.test.ts",
  },
  {
    legacyPath: "packages/core/src/tests/replay-gate.test.ts",
    migratedPath: "packages/workbench/src/core/tests/replay-gate.test.ts",
  },
  {
    legacyPath: "packages/editor/src/tests/editor.test.tsx",
    migratedPath: "packages/workbench/src/editor/tests/editor.test.tsx",
  },
  {
    legacyPath: "packages/icons/src/tests/icons.test.tsx",
    migratedPath: "packages/workbench/src/icons/tests/icons.test.tsx",
  },
  {
    legacyPath: "packages/preview/src/tests/preview.test.tsx",
    migratedPath: "packages/workbench/src/preview/tests/preview.test.tsx",
  },
  {
    legacyPath: "packages/terminal/src/tests/terminal.test.tsx",
    migratedPath: "packages/workbench/src/terminal/tests/terminal.test.tsx",
  },
  {
    legacyPath: "packages/tokens/src/tests/tokens.test.ts",
    migratedPath: "packages/workbench/src/tokens/tests/tokens.test.ts",
  },
  {
    legacyPath: "packages/tree/src/tests/tree-engine.test.ts",
    migratedPath: "packages/workbench/src/tree/tests/tree-engine.test.ts",
  },
  {
    legacyPath: "packages/tree/src/tests/tree-view.test.tsx",
    migratedPath: "packages/workbench/src/tree/tests/tree-view.test.tsx",
  },
  {
    legacyPath: "packages/ui/src/tests/ui.test.tsx",
    migratedPath: "packages/workbench/src/ui/tests/ui.test.tsx",
  },
];

const ROOT = process.cwd();
const PKG_DIR = path.join(ROOT, "packages/workbench");

const listed = spawnSync("bunx", ["vitest", "list", "--filesOnly"], {
  cwd: PKG_DIR,
  encoding: "utf8",
});
if (listed.status !== 0) {
  console.error("check-test-inventory: vitest list failed:\n", listed.stdout, listed.stderr);
  process.exit(1);
}

const discovered = new Set(
  listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((entry) => {
      const abs = path.isAbsolute(entry) ? entry : path.resolve(PKG_DIR, entry);
      return path.relative(ROOT, abs).replaceAll(path.sep, "/");
    }),
);

const missing: string[] = [];
for (const suite of REQUIRED_MIGRATED_SUITES) {
  const full = path.join(ROOT, suite.migratedPath);
  if (!existsSync(full)) {
    missing.push(`${suite.migratedPath} (from ${suite.legacyPath}): file does not exist`);
    continue;
  }
  if (!discovered.has(suite.migratedPath)) {
    missing.push(`${suite.migratedPath} (from ${suite.legacyPath}): not discovered by vitest`);
  }
}

if (missing.length > 0) {
  console.error("check-test-inventory failed:");
  for (const item of missing) console.error(`  - ${item}`);
  process.exit(1);
}

console.log(
  `check-test-inventory: ok (${REQUIRED_MIGRATED_SUITES.length}/${REQUIRED_MIGRATED_SUITES.length} migrated suites discovered by vitest; total discovered: ${discovered.size})`,
);
