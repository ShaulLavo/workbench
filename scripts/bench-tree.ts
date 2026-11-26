import { readFileSync } from "node:fs";
import path from "node:path";
import { FileTreeModel, prepareFileTreeInput } from "../packages/tree/src/index";

const PATH_COUNTS = [10_000, 50_000] as const;
const WARMUP_ROUNDS = 3;
const SAMPLE_ROUNDS = 9;
const REMOUNT_SPEEDUP_GATE = 0.2;
const COLD_SLOWDOWN_GATE = 0.15;
const BASELINE_HEADROOM = 1.2;

interface TimingSample {
  readonly preparedColdMs: number;
  readonly preparedRemountMs: number;
  readonly rawColdMs: number;
  readonly rawRemountMs: number;
}

interface BenchmarkRow {
  readonly pathCount: number;
  readonly preparedColdMedianMs: number;
  readonly preparedRemountMedianMs: number;
  readonly rawColdMedianMs: number;
  readonly rawRemountMedianMs: number;
  readonly coldSlowdown: number;
  readonly remountSpeedup: number;
}

interface BaselineFile {
  readonly results: readonly BenchmarkRow[];
}

/** Matches Fregat's pre-cutover `file-tree-prepared-input-benchmark.ts` path layout 1-to-1. */
function deterministicPaths(pathCount: number): readonly string[] {
  const paths: string[] = [];
  for (let index = 0; index < pathCount; index += 1) {
    const group = index % 250;
    const feature = Math.floor(index / 250) % 40;
    const directory = `packages/package-${String(group).padStart(3, "0")}/feature-${String(feature).padStart(2, "0")}`;
    if (index % 11 === 0) {
      paths.push(`${directory}/nested-${String(index).padStart(5, "0")}/`);
      continue;
    }
    const extension = index % 5 === 0 ? "tsx" : "ts";
    paths.push(`${directory}/file-${String(index).padStart(5, "0")}.${extension}`);
  }
  return paths;
}

function median(samples: readonly number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function ratio(delta: number, baseline: number): number {
  return baseline === 0 ? 0 : delta / baseline;
}

function measureRound(paths: readonly string[]): TimingSample {
  const rawColdStart = performance.now();
  new FileTreeModel({ paths });
  const rawColdMs = performance.now() - rawColdStart;

  const rawRemountStart = performance.now();
  new FileTreeModel({ paths });
  const rawRemountMs = performance.now() - rawRemountStart;

  const preparedColdStart = performance.now();
  const preparedInput = prepareFileTreeInput(paths);
  new FileTreeModel({ preparedInput });
  const preparedColdMs = performance.now() - preparedColdStart;

  const preparedRemountStart = performance.now();
  new FileTreeModel({ preparedInput });
  const preparedRemountMs = performance.now() - preparedRemountStart;

  return { preparedColdMs, preparedRemountMs, rawColdMs, rawRemountMs };
}

function runForCount(pathCount: number): BenchmarkRow {
  const paths = deterministicPaths(pathCount);
  for (let i = 0; i < WARMUP_ROUNDS; i += 1) {
    measureRound(paths);
  }
  const samples: TimingSample[] = [];
  for (let i = 0; i < SAMPLE_ROUNDS; i += 1) {
    samples.push(measureRound(paths));
  }

  const pCold = median(samples.map((s) => s.preparedColdMs));
  const pRemount = median(samples.map((s) => s.preparedRemountMs));
  const rCold = median(samples.map((s) => s.rawColdMs));
  const rRemount = median(samples.map((s) => s.rawRemountMs));

  return {
    pathCount,
    preparedColdMedianMs: round(pCold),
    preparedRemountMedianMs: round(pRemount),
    rawColdMedianMs: round(rCold),
    rawRemountMedianMs: round(rRemount),
    coldSlowdown: round(ratio(pCold - rCold, rCold)),
    remountSpeedup: round(ratio(rRemount - pRemount, rRemount)),
  };
}

const results = PATH_COUNTS.map(runForCount);
console.log(JSON.stringify({ results }, null, 2));

if (process.argv.includes("--gate")) {
  const baselinePath = path.join(process.cwd(), "benchmarks/tree-baseline.json");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineFile;
  const failures: string[] = [];

  for (const expectedCount of PATH_COUNTS) {
    const actual = results.find((row) => row.pathCount === expectedCount);
    const ref = baseline.results.find((row) => row.pathCount === expectedCount);
    if (!actual) {
      failures.push(`missing actual benchmark row for ${expectedCount} paths`);
      continue;
    }
    if (!ref) {
      failures.push(
        `missing baseline benchmark row for ${expectedCount} paths in benchmarks/tree-baseline.json`,
      );
      continue;
    }
    const coldLimit = round(ref.preparedColdMedianMs * BASELINE_HEADROOM);
    const remountLimit = round(ref.preparedRemountMedianMs * BASELINE_HEADROOM);
    if (actual.preparedColdMedianMs > coldLimit) {
      failures.push(
        `${actual.pathCount} paths cold median ${actual.preparedColdMedianMs}ms exceeded baseline ${ref.preparedColdMedianMs}ms (+20% cap ${coldLimit}ms)`,
      );
    }
    if (actual.preparedRemountMedianMs > remountLimit) {
      failures.push(
        `${actual.pathCount} paths remount median ${actual.preparedRemountMedianMs}ms exceeded baseline ${ref.preparedRemountMedianMs}ms (+20% cap ${remountLimit}ms)`,
      );
    }
  }

  const large = results.find((row) => row.pathCount === 50_000);
  if (!large) {
    failures.push("missing 50,000-path result");
  } else {
    if (large.remountSpeedup < REMOUNT_SPEEDUP_GATE) {
      failures.push(`50k remount speedup ${large.remountSpeedup} is below ${REMOUNT_SPEEDUP_GATE}`);
    }
    if (large.coldSlowdown > COLD_SLOWDOWN_GATE) {
      failures.push(`50k cold slowdown ${large.coldSlowdown} exceeds ${COLD_SLOWDOWN_GATE}`);
    }
  }

  if (failures.length > 0) {
    console.error("bench:tree:gate failed:");
    for (const msg of failures) console.error(`  - ${msg}`);
    process.exit(1);
  }
  console.log("bench:tree:gate: ok (matches or beats Fregat pre-cutover baseline)");
}
