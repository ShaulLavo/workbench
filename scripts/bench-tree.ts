import { readFileSync } from "node:fs";
import path from "node:path";
import { FileTreeModel, prepareFileTreeInput } from "../packages/tree/src/index";

const ITERATIONS = 7;
const PATH_COUNTS = [10_000, 50_000] as const;
const GATE_HEADROOM = 1.2;

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

function buildPaths(count: number): string[] {
  const paths: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const group = `pkg-${String(i % 250).padStart(3, "0")}`;
    const feature = `feature-${String(Math.floor(i / 250) % 40).padStart(2, "0")}`;
    const leaf =
      i % 11 === 0 ? `nested-${String(i).padStart(5, "0")}/` : `file-${String(i).padStart(5, "0")}.ts`;
    paths.push(`packages/${group}/src/${feature}/${leaf}`);
  }
  return paths;
}

function median(samples: readonly number[]): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measure(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

function round(ms: number): number {
  return Number(ms.toFixed(3));
}

function runForCount(pathCount: number): BenchmarkRow {
  const paths = buildPaths(pathCount);
  const preparedCold: number[] = [];
  const preparedRemount: number[] = [];
  const rawCold: number[] = [];
  const rawRemount: number[] = [];

  for (let i = 0; i < ITERATIONS; i += 1) {
    let preparedInput = prepareFileTreeInput([]);
    preparedCold.push(
      measure(() => {
        preparedInput = prepareFileTreeInput(paths);
        const model = new FileTreeModel({ preparedInput, initialExpanded: ["packages"] });
        model.getSnapshot();
      }),
    );
    preparedRemount.push(
      measure(() => {
        const model = new FileTreeModel({ preparedInput, initialExpanded: ["packages"] });
        model.getSnapshot();
      }),
    );
    rawCold.push(
      measure(() => {
        const model = new FileTreeModel({ paths, initialExpanded: ["packages"] });
        model.getSnapshot();
      }),
    );
    rawRemount.push(
      measure(() => {
        const model = new FileTreeModel({ paths, initialExpanded: ["packages"] });
        model.getSnapshot();
      }),
    );
  }

  const pCold = median(preparedCold);
  const pRemount = median(preparedRemount);
  const rCold = median(rawCold);
  const rRemount = median(rawRemount);

  return {
    pathCount,
    preparedColdMedianMs: round(pCold),
    preparedRemountMedianMs: round(pRemount),
    rawColdMedianMs: round(rCold),
    rawRemountMedianMs: round(rRemount),
    coldSlowdown: round((pCold - rCold) / rCold),
    remountSpeedup: round((rRemount - pRemount) / rRemount),
  };
}

const results = PATH_COUNTS.map(runForCount);
console.log(JSON.stringify({ results }, null, 2));

if (process.argv.includes("--gate")) {
  const baselinePath = path.join(process.cwd(), "benchmarks/tree-baseline.json");
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BaselineFile;
  const failures: string[] = [];

  for (const actual of results) {
    const ref = baseline.results.find((row) => row.pathCount === actual.pathCount);
    if (!ref) continue;
    const coldLimit = round(ref.preparedColdMedianMs * GATE_HEADROOM);
    const remountLimit = round(ref.preparedRemountMedianMs * GATE_HEADROOM);
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

  if (failures.length > 0) {
    console.error("bench:tree:gate failed:");
    for (const msg of failures) console.error(`  - ${msg}`);
    process.exit(1);
  }
  console.log("bench:tree:gate: ok (matches or beats Fregat pre-cutover baseline)");
}
