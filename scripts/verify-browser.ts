import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium, webkit } from "playwright";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const verb = args[0] ?? "look";
const engineFlag = args.includes("--engine") ? args[args.indexOf("--engine") + 1] : "chromium";
const engine = engineFlag === "webkit" ? "webkit" : "chromium";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("Could not allocate free loopback port"));
      });
    });
    server.on("error", reject);
  });
}

async function waitForServer(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry until server listens
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for harness server at ${url}`);
}

async function main(): Promise<void> {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 16);
  const evidenceDir = path.join(os.tmpdir(), "workbench-evidence", `${stamp}-${verb}-${engine}`);
  mkdirSync(evidenceDir, { recursive: true });

  const vite = spawn(
    "bun",
    [
      "run",
      "--cwd",
      "apps/harness",
      "dev",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    {
      cwd: ROOT,
      stdio: "pipe",
    },
  );

  const browserType = engine === "webkit" ? webkit : chromium;
  let browser: Awaited<ReturnType<typeof browserType.launch>> | undefined;

  try {
    await waitForServer(`${baseUrl}/`);
    browser = await browserType.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });
    page.on("requestfailed", (req) =>
      errors.push(`requestfailed: ${req.url()} (${req.failure()?.errorText ?? "unknown"})`),
    );

    // Capture plain-CSS host (Sprockt-like) and Tailwind v4 host (Fregat-like).
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="harness-ready"]');
    await page.screenshot({ path: path.join(evidenceDir, "plain-host.png") });

    await page.goto(`${baseUrl}/tailwind.html`, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="harness-ready"]');
    await page.screenshot({ path: path.join(evidenceDir, "tailwind-host.png") });

    writeFileSync(path.join(evidenceDir, "observed.json"), JSON.stringify({ engine, errors }, null, 2));
    writeFileSync(
      path.join(evidenceDir, "summary.md"),
      `# verify-workbench (${verb}, ${engine})\n\n- Evidence: \`${evidenceDir}\`\n- Errors: ${errors.length}\n- Screenshots: \`plain-host.png\`, \`tailwind-host.png\`\n`,
    );

    console.log(`Evidence directory: ${evidenceDir}`);
    console.log(`Errors: ${errors.length}`);
    if (errors.length > 0) {
      for (const err of errors) console.error(`  - ${err}`);
      process.exit(1);
    }
  } finally {
    await browser?.close();
    vite.kill("SIGTERM");
  }
}

await main();
