import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const VIBE_URL = "http://127.0.0.1:4174/";

test("vibe-builder starter kit runs complete Consumer 3 workbench loop in under 300 lines of adapter glue", async ({
  page,
}, testInfo) => {
  const adaptersPath = path.resolve(import.meta.dirname, "../../../examples/vibe-builder/src/adapters.ts");
  const lineCount = readFileSync(adaptersPath, "utf8").split("\n").length;
  expect(lineCount).toBeLessThan(300);

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });

  await page.goto(VIBE_URL);
  await expect(page.getByTestId("vibe-ready")).toBeVisible();

  // Verify folder create + recursive folder move + recursive folder remove work on the writable starter FileSystemAdapter.
  const fsCheck = await page.evaluate(async () => {
    const adaptersUrl = "/src/adapters.ts";
    const mod = (await import(adaptersUrl)) as {
      readonly createVibeBuilderBackend: () => {
        readonly fs: {
          createDirectory(p: string): Promise<void>;
          move(from: string, to: string): Promise<void>;
          remove(p: string): Promise<void>;
          readText(p: string): Promise<string | undefined>;
          readonly indexed?: {
            readonly snapshot: {
              getSnapshot(): {
                readonly entries: readonly { readonly path: string; readonly kind: string }[];
              };
            };
          };
        };
      };
    };
    const backendCheck = mod.createVibeBuilderBackend();
    await backendCheck.fs.createDirectory("src/empty-dir");
    const hasEmptyDir =
      backendCheck.fs.indexed?.snapshot
        .getSnapshot()
        ?.entries.some((e) => e.path === "src/empty-dir" && e.kind === "directory") ?? false;
    await backendCheck.fs.move("src/routes", "src/pages");
    const movedText = await backendCheck.fs.readText("src/pages/pricing.tsx");
    const oldText = await backendCheck.fs.readText("src/routes/pricing.tsx");
    await backendCheck.fs.remove("src/pages");
    const removedText = await backendCheck.fs.readText("src/pages/pricing.tsx");
    const afterRemove = backendCheck.fs.indexed?.snapshot.getSnapshot()?.entries ?? [];
    const hasLeftover = afterRemove.some((e) => e.path === "src/pages" || e.path.startsWith("src/pages/"));
    return { hasEmptyDir, movedText, oldText, removedText, hasLeftover };
  });
  expect(fsCheck.hasEmptyDir).toBe(true);
  expect(fsCheck.movedText).toContain("Pro plan");
  expect(fsCheck.oldText).toBeUndefined();
  expect(fsCheck.removedText).toBeUndefined();
  expect(fsCheck.hasLeftover).toBe(false);

  const isTouch = testInfo.project.name === "webkit-touch";
  if (isTouch) {
    await page.getByTestId("mobile-pane-editor").tap();
  }

  // Initial Singapore editor mounts src/App.tsx cleanly.
  const appEditor = page.locator('[data-wb-editor][data-document-id="src/App.tsx"]').first();
  await expect(appEditor).toHaveAttribute("data-status", "ready", { timeout: 10000 });
  await expect(appEditor).toContainText("Vibe Starter");

  if (!isTouch) {
    // FileTreeView opens a file into EditorWorkbench.
    await page.getByTestId("wb-tree-row-src").click();
    await page.getByTestId("wb-tree-row-src/routes").click();
    await page.getByTestId("wb-tree-row-src/routes/pricing.tsx").click();
    const pricingEditor = page.locator('[data-wb-editor][data-document-id="src/routes/pricing.tsx"]').first();
    await expect(pricingEditor).toHaveAttribute("data-status", "ready", { timeout: 10000 });
    await expect(pricingEditor).toContainText("Pro plan");

    // Bridge-less remote PreviewPane renders / and navigates to /pricing with zero bridge or errors.
    const previewPane = page.locator("[data-wb-preview]");
    const iframe = page.getByTestId("wb-preview-iframe");
    await expect(iframe).toBeVisible();
    await expect(previewPane).toHaveAttribute("data-bridge-state", "bridgeless", { timeout: 10000 });
    const frame = page.frameLocator('[data-testid="wb-preview-iframe"]');
    await expect(frame.locator("#route-heading")).toHaveText("Route: /");
    const urlInput = page.getByTestId("wb-preview-url-input");
    await urlInput.fill("/pricing");
    await urlInput.press("Enter");
    await expect(frame.locator("#route-heading")).toHaveText("Route: /pricing");
    await page.getByTestId("wb-preview-reload").click();

    // TerminalPanel mounts Ghostty surface.
    await expect(page.locator("[data-wb-terminal]").first()).toBeVisible({ timeout: 10000 });
  }

  // MarkdownComposer: real @file mention -> / slash command -> Enter submit round trip.
  const composer = page.getByTestId("wb-markdown-composer");
  await expect(composer).toBeVisible();
  await composer.getByTestId("wb-composer-surface").click();
  await page.keyboard.type("Update @pricing");
  await expect(page.getByTestId("wb-composer-mention-menu")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer.locator('[data-wb-mention-chip="src/routes/pricing.tsx"]')).toBeVisible();

  await page.keyboard.type("/fi");
  await expect(page.getByTestId("wb-composer-slash-menu")).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("vibe-command-status")).toContainText("command: fix");

  await page.keyboard.press("Enter");
  const timeline = page.getByTestId("vibe-agent-timeline");
  await expect(timeline).toContainText("src/routes/pricing.tsx");
  await expect(timeline).toContainText("Applied request for src/routes/pricing.tsx");

  expect(errors).toEqual([]);
});
