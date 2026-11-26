import { expect, test } from "@playwright/test";

for (const host of [
  { name: "plain-CSS (Sprockt)", path: "/" },
  { name: "Tailwind v4 (Fregat)", path: "/tailwind.html" },
] as const) {
  test(`overlays-and-portals on ${host.name}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(host.path);
    await expect(page.getByTestId("harness-ready")).toBeVisible();

    // Verify CLAUDE.md rich icon uses the MIT/CC0 claude glyph in the tab strip.
    const claudeTab = page.getByTestId("sample-tab-CLAUDE.md");
    await expect(claudeTab.locator('[data-wb-icon="claude"]')).toBeVisible();

    // CommandPalette opens inside the scoped [data-wb-portal-root], filters, runs on Enter, and shows a toast.
    await page.getByTestId("open-palette").click();
    const paletteInPortal = page.locator(
      '[data-wb-theme-scope] [data-wb-portal-root] [data-testid="wb-command-palette"]',
    );
    await expect(paletteInPortal).toBeVisible();

    const paletteInput = page.getByTestId("wb-command-palette-input");
    await paletteInput.fill("saved");
    await paletteInput.press("Enter");
    await expect(paletteInPortal).toBeHidden();

    const toastInPortal = page.locator(
      '[data-wb-theme-scope] [data-wb-portal-root] [data-testid="wb-toast-saved-toast"]',
    );
    await expect(toastInPortal).toBeVisible();

    // ConfirmDialog mounts inside [data-wb-portal-root] and focuses Cancel first so Enter is safe.
    await page.getByTestId("open-confirm").click();
    const confirmInPortal = page.locator(
      '[data-wb-theme-scope] [data-wb-portal-root] [data-testid="wb-confirm-dialog"]',
    );
    await expect(confirmInPortal).toBeVisible();
    await expect(page.getByTestId("wb-confirm-cancel")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirmInPortal).toBeHidden();

    // PointContextMenu mounts inside [data-wb-portal-root] with Kbd shortcut hints.
    await page.getByTestId("open-context-menu").click();
    const menuInPortal = page.locator(
      "[data-wb-theme-scope] [data-wb-portal-root] [data-wb-point-context-menu]",
    );
    await expect(menuInPortal).toBeVisible();
    await expect(menuInPortal.locator("[data-wb-kbd]").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menuInPortal).toBeHidden();

    // Delegated TooltipLayer renders inside [data-wb-portal-root] on desktop hover.
    if (testInfo.project.name !== "webkit-touch") {
      await page.getByTestId("activity-search").hover();
      const tooltipInPortal = page.locator(
        "[data-wb-theme-scope] [data-wb-portal-root] [data-wb-tooltip-popup]",
      );
      await expect(tooltipInPortal).toBeVisible({ timeout: 3000 });
      await expect(tooltipInPortal).toContainText("Search");
    }

    expect(errors).toEqual([]);
  });
}

test("layout-splitter-mobile resizes desktop panes and switches/collapses mobile shell", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page.getByTestId("harness-ready")).toBeVisible();

  if (testInfo.project.name === "webkit-touch") {
    const switcher = page.locator("[data-wb-pane-switcher]");
    await expect(switcher).toBeVisible();

    // Switch to Files pane on touch and verifyCLAUDE.md row renders.
    await page.getByTestId("mobile-pane-explorer").tap();
    await expect(page.getByTestId("file-row-CLAUDE.md")).toBeVisible();

    // Return to Editor, focus editor input, then verify keyboard-open collapses switcher.
    await page.getByTestId("mobile-pane-editor").tap();
    await page.getByTestId("simulate-keyboard").tap();
    await expect(switcher).toBeHidden();
    await page.getByTestId("simulate-keyboard").tap();
    await expect(switcher).toBeVisible();
    return;
  }

  // Desktop: resize explorer via keyboard ArrowRight and toggle closed/open via Enter.
  const explorerPane = page.locator('[data-wb-pane="explorer"]');
  const initialBox = await explorerPane.boundingBox();
  expect(initialBox?.width ?? 0).toBeGreaterThan(150);

  const explorerSplitter = page.locator('[data-wb-splitter="explorer"]');
  await explorerSplitter.focus();
  await explorerSplitter.press("ArrowRight");
  const widerBox = await explorerPane.boundingBox();
  expect(widerBox?.width ?? 0).toBeGreaterThan(initialBox?.width ?? 0);

  await explorerSplitter.press("Enter");
  await expect(explorerPane).toBeHidden();
  await explorerSplitter.press("Enter");
  await expect(explorerPane).toBeVisible();
});
