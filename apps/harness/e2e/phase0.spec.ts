import { expect, test } from "@playwright/test";

test("boot-smoke & css-tokens-smoke on plain-CSS host (Sprockt) and Tailwind v4 host (Fregat)", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });

  // Plain-CSS host (Sprockt Sheet & Biro)
  await page.goto("/");
  await expect(page.getByTestId("harness-ready")).toHaveAttribute("data-host-kind", "plain");
  await expect(page.getByTestId("root-theme-probe")).toContainText("observedScheme: light");
  await expect(page.getByTestId("root-theme-probe")).toContainText("terminalBg: rgb(255, 255, 255)");

  await page.getByTestId("toggle-mode").click();
  await expect(page.getByTestId("root-theme-probe")).toContainText("observedScheme: dark");
  await expect(page.getByTestId("root-theme-probe")).toContainText("terminalBg: rgb(10, 13, 20)");

  // Scoped embedded theme updates independently of root and sets matching text ink color
  const scopedProbe = page.getByTestId("scoped-theme-probe");
  await expect(scopedProbe).toContainText("scopedObserved: dark");
  await expect(scopedProbe).toHaveCSS("color", "rgb(233, 237, 243)");
  await page.getByTestId("toggle-scoped-mode").click();
  await expect(scopedProbe).toContainText("scopedObserved: light");
  await expect(scopedProbe).toHaveCSS("color", "rgb(17, 17, 17)");

  // Tailwind v4 host (Fregat Graphite)
  await page.goto("/tailwind.html");
  await expect(page.getByTestId("harness-ready")).toHaveAttribute("data-host-kind", "tailwind");
  await expect(page.getByTestId("root-theme-probe")).toContainText("observedScheme: dark");
  await expect(page.getByTestId("root-theme-probe")).toContainText("preset: fregat");

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
