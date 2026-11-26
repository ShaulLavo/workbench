import { expect, test } from "@playwright/test";

for (const host of [
  { name: "plain-CSS (Sprockt)", path: "/" },
  { name: "Tailwind v4 (Fregat)", path: "/tailwind.html" },
] as const) {
  test(`tree-interactions on ${host.name}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(host.path);
    await expect(page.getByTestId("harness-ready")).toBeVisible();

    const isTouch = testInfo.project.name === "webkit-touch";
    if (isTouch) {
      // Pre-focus editor input on Editor pane, switch to Files, tap CLAUDE.md -> focus=false and editor not focused.
      const editorInput = page.getByTestId("mock-editor-input");
      await editorInput.focus();
      await page.getByTestId("mobile-pane-explorer").tap();
      const claudeRow = page.getByTestId("wb-tree-row-CLAUDE.md");
      await expect(claudeRow).toBeVisible();
      await claudeRow.tap();
      await expect(page.getByTestId("focus-decision")).toContainText("focus=false");
      await expect(editorInput).not.toBeFocused();

      // Switch back to Files pane and exercise Lazy retry on touch.
      await page.getByTestId("mobile-pane-explorer").tap();
      await page.getByTestId("tree-mode-lazy").tap();
      const retryBtn = page.getByTestId("wb-tree-retry-remote-logs");
      await expect(retryBtn).toBeVisible();
      await retryBtn.tap();
      await expect(page.getByTestId("wb-tree-row-remote-logs/server.log")).toBeVisible();
      expect(errors).toEqual([]);
      return;
    }

    // Populated tree exposes an initial keyboard Tab stop before any click.
    await expect(page.locator('[data-wb-tree-scroller] [tabindex="0"]')).toHaveCount(1);

    // Compact folder chain (features/editor under src) with per-segment drop targets + Git badges & ignored dimming.
    const compactRow = page.getByTestId("wb-tree-row-src/features/editor");
    await expect(compactRow).toBeVisible();
    await expect(page.getByTestId("wb-tree-segment-src/features")).toBeVisible();
    await expect(page.getByTestId("wb-tree-segment-src/features/editor")).toBeVisible();
    await expect(compactRow.locator('[data-wb-git-dot="true"]')).toBeVisible();

    // Dragging src/App.test.tsx onto docs issues exactly one move into docs/ (never a second move to root).
    const appTestRow = page.getByTestId("wb-tree-row-src/App.test.tsx");
    const docsRow = page.getByTestId("wb-tree-row-docs");
    await appTestRow.dragTo(docsRow);
    await expect(page.getByTestId("wb-tree-row-docs/App.test.tsx")).toBeVisible();
    await expect(page.getByTestId("wb-tree-row-App.test.tsx")).toHaveCount(0);

    // ArrowLeft on expanded compact chain collapses src/features and transfers focus to src/features.
    await compactRow.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("wb-tree-row-src/features")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(compactRow).toBeVisible();

    const appRow = page.getByTestId("wb-tree-row-src/features/editor/App.tsx");
    await expect(appRow).toBeVisible();
    await expect(appRow.locator(".wb-tree-git-badge")).toHaveText("M");

    const ignoredRow = page.getByTestId("wb-tree-row-node_modules");
    await expect(ignoredRow).toHaveAttribute("data-ignored", "true");

    // Contiguous multi-select pill edges via Shift-click.
    const claudeRow = page.getByTestId("wb-tree-row-CLAUDE.md");
    const licenseRow = page.getByTestId("wb-tree-row-LICENSE");
    const packageRow = page.getByTestId("wb-tree-row-package.json");
    await claudeRow.click();
    await packageRow.click({ modifiers: ["Shift"] });
    await expect(claudeRow).toHaveAttribute("data-selection-edge", "start");
    await expect(licenseRow).toHaveAttribute("data-selection-edge", "middle");
    await expect(packageRow).toHaveAttribute("data-selection-edge", "end");

    // Clicking a file on desktop focuses the editor; focusing the tree and pressing ArrowDown switches to keyboard modality.
    await claudeRow.click();
    await expect(page.getByTestId("mock-editor-input")).toBeFocused();
    await claudeRow.focus();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator("[data-wb-tree-scroller]")).toHaveAttribute("data-focus-modality", "keyboard");
    await expect(licenseRow).toBeFocused();

    // F2 inline rename validates duplicates and commits valid renames.
    await page.keyboard.press("F2");
    const renameInput = page.getByTestId("wb-tree-inline-input");
    await expect(renameInput).toBeVisible();
    await renameInput.fill("README.md");
    await expect(renameInput).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator(".wb-inline-rename-error")).toContainText("already exists");
    await renameInput.fill("LICENSE.txt");
    await renameInput.press("Enter");
    await expect(page.getByTestId("wb-tree-row-LICENSE.txt")).toBeVisible();

    // Inline filter hides ignored node_modules and filters visible entries, Escape clears and restores.
    const filterInput = page.getByLabel("Filter files");
    await filterInput.fill("CLAUDE");
    await expect(claudeRow).toBeVisible();
    await expect(ignoredRow).toBeHidden();
    await filterInput.fill("");

    // Lazy directory error + Retry recovery.
    await page.getByTestId("tree-mode-lazy").click();
    const retryBtn = page.getByTestId("wb-tree-retry-remote-logs");
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();
    await expect(page.getByTestId("wb-tree-row-remote-logs/server.log")).toBeVisible();

    // 50,000-file scale mode: scrolls cleanly and pins sticky ancestor header (`packages`).
    await page.getByTestId("tree-mode-50k").click();
    const scroller = page.locator("[data-wb-tree-scroller]");
    await expect(scroller).toBeVisible();
    await scroller.evaluate((el) => {
      el.scrollTop = 260;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect(page.getByTestId("wb-tree-sticky-packages")).toBeVisible();

    expect(errors).toEqual([]);
  });
}
