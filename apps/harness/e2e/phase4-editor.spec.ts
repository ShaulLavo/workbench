import { expect, test } from "@playwright/test";

for (const host of [
  { name: "plain-CSS (Sprockt)", path: "/" },
  { name: "Tailwind v4 (Fregat)", path: "/tailwind.html" },
] as const) {
  test(`editor-theme-and-groups on ${host.name}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(host.path);
    await expect(page.getByTestId("harness-ready")).toBeVisible();

    const isTouch = testInfo.project.name === "webkit-touch";
    if (isTouch) {
      await page.getByTestId("mobile-pane-editor").tap();
    }

    // Live Singapore editor mounts inside EditorGroupLayout and shows App.tsx.
    const editorView = page.locator('[data-wb-editor][data-document-id="src/App.tsx"]').first();
    await expect(editorView).toHaveAttribute("data-status", "ready", { timeout: 10000 });
    await expect(editorView).toHaveAttribute("data-analysis-allowed", "true");
    await expect(page.getByTestId("wb-lsp-status")).toContainText("1E · 0W");

    // Toggle theme and verify Singapore editor stays healthy with zero errors.
    await page.getByTestId("toggle-mode").click();

    if (!isTouch) {
      // Split groups: clicking Split editor creates a second group side-by-side.
      await expect(page.locator("[data-wb-editor-group]")).toHaveCount(1);
      await page.getByTestId("editor-split-right").click();
      await expect(page.locator("[data-wb-editor-group]")).toHaveCount(2);

      // DiagnosticPeek opens, shows related info, and closes cleanly on Escape.
      await page.getByTestId("editor-toggle-peek").click();
      const peek = page.getByTestId("wb-diagnostic-peek");
      await expect(peek).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(peek).toHaveCount(0);

      // Conflict bar appears and resolves cleanly via Take theirs.
      await page.getByTestId("editor-trigger-conflict").click();
      await expect(page.getByTestId("wb-editor-conflict-bar")).toBeVisible();
      await page.getByTestId("wb-editor-conflict-theirs").click();
      await expect(page.getByTestId("wb-editor-conflict-bar")).toHaveCount(0);

      // Large file (>2 MiB) disables analysis and displays the large-file tier notice.
      await page.getByTestId("editor-open-large").click();
      await expect(page.getByTestId("wb-editor-large-file-notice")).toBeVisible({ timeout: 10000 });
      await expect(
        page.locator('[data-wb-editor][data-document-id="logs/large.log"]').first(),
      ).toHaveAttribute("data-analysis-allowed", "false");

      // Diff view toggles on and renders split diff panes.
      await page.getByTestId("editor-toggle-diff").click();
      await expect(page.getByTestId("wb-diff-view")).toBeVisible();
      await expect(page.getByTestId("wb-diff-pane-old")).toBeVisible();
      await expect(page.getByTestId("wb-diff-pane-new")).toBeVisible();
      await page.getByTestId("editor-toggle-diff").click();
    }

    expect(errors).toEqual([]);
  });

  test(`markdown-composer on ${host.name}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(host.path);
    await expect(page.getByTestId("harness-ready")).toBeVisible();

    if (testInfo.project.name === "webkit-touch") {
      await page.getByTestId("mobile-pane-editor").tap();
    }

    const composer = page.getByTestId("wb-markdown-composer");
    await expect(composer).toBeVisible();
    await expect(page.getByTestId("wb-composer-placeholder")).toBeVisible();

    // Accessible name "Message" is wired to Singapore's prose input.
    const messageInput = composer.getByLabel("Message");
    await expect(messageInput).toBeAttached();

    // Focus composer, type @app -> mention popup opens -> Enter inserts atomic @src/App.tsx chip.
    await composer.getByTestId("wb-composer-surface").click();
    await page.keyboard.type("Inspect @app");
    await expect(page.getByTestId("wb-composer-mention-menu")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(composer.locator('[data-wb-mention-chip="src/App.tsx"]')).toBeVisible();

    // Atomic single-Backspace deletes the entire @src/App.tsx chip (first Backspace removes trailing space, second deletes whole chip).
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(composer.locator('[data-wb-mention-chip="src/App.tsx"]')).toHaveCount(0);

    // Re-insert @app chip, then test slash command popup -> select /fix inserts command text.
    await page.keyboard.type("@app");
    await expect(page.getByTestId("wb-composer-mention-menu")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(composer.locator('[data-wb-mention-chip="src/App.tsx"]')).toBeVisible();

    await page.keyboard.type("/fi");
    await expect(page.getByTestId("wb-composer-slash-menu")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("composer-command-probe")).toContainText("fix");

    // IME composition Enter must NOT submit the prompt.
    await composer.evaluate((el) => {
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }),
      );
    });
    await expect(page.getByTestId("composer-submit-probe")).toContainText("submitted: none");

    // Submit prompt on Enter -> emits prompt text + extracted mentions and clears composer.
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("composer-submit-probe")).toContainText("src/App.tsx");
    await expect(page.getByTestId("wb-composer-placeholder")).toBeVisible();

    // Dropping a file path into the composer inserts an atomic mention chip.
    await composer.evaluate((el) => {
      const dt = new DataTransfer();
      dt.setData("application/x-workbench-paths", JSON.stringify(["src/styles.css"]));
      el.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    });
    await expect(composer.locator('[data-wb-mention-chip="src/styles.css"]')).toBeVisible();

    expect(errors).toEqual([]);
  });
}

test("mobile-touch-webkit never focuses Singapore editor on file-tab tap", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "webkit-touch", "Touch focus assertion runs on webkit-touch");

  await page.goto("/");
  await expect(page.getByTestId("harness-ready")).toBeVisible();

  const editorView = page.locator('[data-wb-editor][data-document-id="src/App.tsx"]').first();
  await expect(editorView).toHaveAttribute("data-status", "ready", { timeout: 10000 });

  // Focus Singapore editor explicitly via tap on the editor surface first.
  await editorView.getByTestId("wb-editor-surface").tap();
  const activeBeforeTabTap = await page.evaluate(() => {
    const active = document.activeElement;
    return Boolean(active?.closest("[data-wb-editor]"));
  });
  expect(activeBeforeTabTap).toBe(true);

  // Tapping another Singapore file tab blurs the editor input and NEVER focuses the new editor!
  await page.locator('[data-testid="wb-editor-tab-src/styles.css"] button[role="tab"]').tap();
  await expect(page.locator('[data-wb-editor][data-document-id="src/styles.css"]').first()).toHaveAttribute(
    "data-status",
    "ready",
    { timeout: 10000 },
  );

  const focusedInsideEditorAfterTap = await page.evaluate(() => {
    const active = document.activeElement;
    return Boolean(active?.closest(".wb-editor-surface"));
  });
  expect(focusedInsideEditorAfterTap).toBe(false);
});
