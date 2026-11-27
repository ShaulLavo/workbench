import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  timeout: 30_000,
  retries: 0,
  webServer: [
    {
      command: "bun run dev -- --host 127.0.0.1 --port 4173 --strictPort",
      cwd: path.resolve(import.meta.dirname, ".."),
      url: "http://127.0.0.1:4173/",
      reuseExistingServer: !process.env.CI,
      timeout: 20_000,
    },
    {
      command: "bun run dev -- --host 127.0.0.1 --port 4174 --strictPort",
      cwd: path.resolve(import.meta.dirname, "../../../examples/vibe-builder"),
      url: "http://127.0.0.1:4174/",
      reuseExistingServer: !process.env.CI,
      timeout: 20_000,
    },
  ],
  use: {
    baseURL: "http://127.0.0.1:4173",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "webkit-desktop",
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "webkit-touch",
      use: {
        ...devices["iPhone 14"],
        browserName: "webkit",
        hasTouch: true,
      },
    },
  ],
});
