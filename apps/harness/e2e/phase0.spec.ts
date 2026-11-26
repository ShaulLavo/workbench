import { expect, test } from "@playwright/test";

test("boot-smoke & css-tokens-smoke on plain-CSS host (Sprockt) and Tailwind v4 host (Fregat)", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  page.on("requestfailed", (req) => {
    errors.push(`requestfailed: ${req.url()} (${req.failure()?.errorText ?? "unknown"})`);
  });

  // Plain-CSS host (Sprockt Sheet & Biro)
  await page.goto("/");
  await expect(page.getByTestId("harness-ready")).toHaveAttribute("data-host-kind", "plain");
  await expect(page.getByTestId("root-theme-probe")).toContainText("observedScheme: light");
  await expect(page.getByTestId("root-theme-probe")).toContainText("terminalBg: rgb(255, 255, 255)");

  await page.getByTestId("toggle-mode").click();
  await expect(page.getByTestId("root-theme-probe")).toContainText("observedScheme: dark");
  await expect(page.getByTestId("root-theme-probe")).toContainText("terminalBg: rgb(10, 13, 20)");

  // Scoped embedded theme updates independently of root, sets matching text ink color,
  // and inherits live --wb-keyboard-inset from <html> without shadowing it.
  const scopedCard = page.getByTestId("scoped-theme-card");
  const scopedProbe = page.getByTestId("scoped-theme-probe");
  await expect(scopedProbe).toContainText("scopedObserved: dark");
  await expect(scopedProbe).toHaveCSS("color", "rgb(233, 237, 243)");
  await page.evaluate(() => document.documentElement.style.setProperty("--wb-keyboard-inset", "280px"));
  const inheritedInset = await scopedCard.evaluate((el) =>
    getComputedStyle(el).getPropertyValue("--wb-keyboard-inset").trim(),
  );
  expect(inheritedInset).toBe("280px");
  await page.evaluate(() => document.documentElement.style.removeProperty("--wb-keyboard-inset"));

  await page.getByTestId("toggle-scoped-mode").click();
  await expect(scopedProbe).toContainText("scopedObserved: light");
  await expect(scopedProbe).toHaveCSS("color", "rgb(17, 17, 17)");

  // Compact density overrides both Sprockt and Fregat presets on desktop, while coarse touch keeps 44px (2.75rem) rows.
  const expectedCompactRow = testInfo.project.name === "webkit-touch" ? "2.75rem" : "1.375rem";
  await page.getByTestId("toggle-density").click();
  const compactSprocktRow = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--wb-tree-row-height").trim(),
  );
  expect(compactSprocktRow).toBe(expectedCompactRow);
  await page.getByTestId("preset-fregat").click();
  const compactFregatRow = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--wb-tree-row-height").trim(),
  );
  expect(compactFregatRow).toBe(expectedCompactRow);

  // Compact density without any preset still respects desktop compact vs coarse 44px touch target.
  await page.evaluate(() => {
    delete document.documentElement.dataset.wbTheme;
  });
  const compactNoPresetRow = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--wb-tree-row-height").trim(),
  );
  expect(compactNoPresetRow).toBe(expectedCompactRow);

  // Tailwind v4 host (Fregat Graphite) + @theme inline bridge utility classes
  await page.goto("/tailwind.html");
  await expect(page.getByTestId("harness-ready")).toHaveAttribute("data-host-kind", "tailwind");
  await expect(page.getByTestId("root-theme-probe")).toContainText("observedScheme: dark");
  await expect(page.getByTestId("root-theme-probe")).toContainText("preset: fregat");

  const bridgeProbe = page.getByTestId("tailwind-bridge-probe");
  await expect(bridgeProbe).toBeVisible();
  const bridgeCheck = await bridgeProbe.evaluate((el) => {
    const style = getComputedStyle(el);
    const expectedProbe = document.createElement("span");
    expectedProbe.style.color = "var(--wb-fg)";
    expectedProbe.style.backgroundColor = "var(--wb-bg-well)";
    document.body.appendChild(expectedProbe);
    const expectedStyle = getComputedStyle(expectedProbe);
    const result = {
      actualBg: style.backgroundColor,
      expectedBg: expectedStyle.backgroundColor,
      actualColor: style.color,
      expectedColor: expectedStyle.color,
    };
    expectedProbe.remove();
    return result;
  });
  expect(bridgeCheck.actualBg).toBe(bridgeCheck.expectedBg);
  expect(bridgeCheck.actualColor).toBe(bridgeCheck.expectedColor);
  expect(bridgeCheck.actualColor).not.toBe("rgb(255, 0, 255)");

  expect(errors).toEqual([]);
});

test("per-activation touch focus never focuses editor on file-tab tap", async ({ page }, testInfo) => {
  await page.goto("/");
  const editorInput = page.getByTestId("mock-editor-input");
  const stylesTab = page.getByTestId("sample-tab-src/styles.css");

  // Pre-focus the editor input (simulating an open soft keyboard).
  await editorInput.focus();
  await expect(editorInput).toBeFocused();

  if (testInfo.project.name === "webkit-touch") {
    await stylesTab.tap();
    await expect(page.getByTestId("focus-decision")).toContainText("focus=false");
    await expect(editorInput).not.toBeFocused();
  } else {
    await stylesTab.click();
    await expect(page.getByTestId("focus-decision")).toContainText("focus=true");
    await expect(editorInput).toBeFocused();
  }
});
