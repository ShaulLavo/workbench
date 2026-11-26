import { expect, test } from "@playwright/test";

for (const host of [
  { name: "plain-CSS (Sprockt)", path: "/" },
  { name: "Tailwind v4 (Fregat)", path: "/tailwind.html" },
] as const) {
  test(`terminal-theme-and-replay on ${host.name}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(host.path);
    await expect(page.getByTestId("harness-ready")).toBeVisible();

    const isTouch = testInfo.project.name === "webkit-touch";
    if (isTouch) {
      await page.getByTestId("mobile-pane-terminal").tap();
    }

    // Live Ghostty canvas mounts, completes ordered ReplayGate (`ready` -> replay -> `replay-complete` -> first paint).
    const termView = page.locator('[data-wb-terminal][data-session-id="bash-1"]');
    await expect(termView).toHaveAttribute("data-ready", "true", { timeout: 15000 });
    await expect(termView.locator("canvas").first()).toBeVisible();

    // Verify initial scheme matches host (light for plain Sprockt, dark for Tailwind Fregat).
    const initialScheme = host.path === "/" ? "light" : "dark";
    await expect(termView).toHaveAttribute("data-color-scheme", initialScheme);

    // Verify DECCKM hardware key dispatch via TerminalAccessoryBar:
    // First tap Up Arrow in normal mode -> ESC [ A.
    await page.getByTestId("wb-term-key-up").click();
    if (isTouch) {
      await page.getByTestId("mobile-pane-editor").tap();
    }
    await expect(page.getByTestId("terminal-stats-probe")).toContainText("lastInput: <ESC>[A");

    // Enable DECCKM mode, tap Up Arrow again -> ESC O A!
    await page.getByTestId("enable-decckm").click();
    if (isTouch) {
      await page.getByTestId("mobile-pane-terminal").tap();
    }
    await page.getByTestId("wb-term-key-up").click();
    if (isTouch) {
      await page.getByTestId("mobile-pane-editor").tap();
    }
    await expect(page.getByTestId("terminal-stats-probe")).toContainText("lastInput: <ESC>OA");

    // Toggle color scheme live and verify Ghostty canvas theme updates reactively without remount.
    await page.getByTestId("toggle-mode").click();
    const toggledScheme = initialScheme === "light" ? "dark" : "light";
    await expect(page.getByTestId("terminal-appearance-probe")).toContainText(`scheme=${toggledScheme}`);
    if (!isTouch) {
      await expect(termView).toHaveAttribute("data-color-scheme", toggledScheme);
    }

    // Toggle Fregat transparent typed palette override (`backgroundOpacity: 0`, `bg=28,28,26`).
    await page.getByTestId("toggle-terminal-override").click();
    await expect(page.getByTestId("terminal-appearance-probe")).toContainText("opacity=0");
    await expect(page.getByTestId("terminal-appearance-probe")).toContainText("bg=28,28,26");

    // Desktop session tabs: switching tabs detaches view without closing session; split renders 2 terminals.
    if (!isTouch) {
      await page.getByTestId("wb-term-tab-logs-2").click();
      await expect(page.locator('[data-wb-terminal][data-session-id="logs-2"]')).toHaveAttribute(
        "data-ready",
        "true",
        { timeout: 15000 },
      );
      await expect(page.getByTestId("terminal-stats-probe")).toContainText("detaches: 1");
      await expect(page.getByTestId("terminal-stats-probe")).toContainText("closes: 0");

      await page.getByTestId("wb-term-split").click();
      await expect(page.locator("[data-wb-terminal]")).toHaveCount(2);
    }

    expect(errors).toEqual([]);
  });

  test(`preview-bridged-and-remote on ${host.name}`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
    });

    await page.goto(host.path);
    await expect(page.getByTestId("harness-ready")).toBeVisible();

    const isTouch = testInfo.project.name === "webkit-touch";
    if (isTouch) {
      await page.getByTestId("mobile-pane-preview").tap();
    }

    // Bridged mode: completes per-document hello handshake (`data-bridge-state="bridged"`).
    const previewPane = page.locator("[data-wb-preview]");
    await expect(previewPane).toHaveAttribute("data-bridge-state", "bridged", { timeout: 10000 });
    const frame = page.frameLocator('[data-testid="wb-preview-iframe"]');
    await expect(frame.locator("#heading")).toHaveText("Preview route: /");

    // Navigate via URL bar -> bridged postMessage updates route without reloading iframe, then Back/Reload work.
    const urlInput = page.getByTestId("wb-preview-url-input");
    await urlInput.fill("/pricing");
    await urlInput.press("Enter");
    await expect(frame.locator("#heading")).toHaveText("Preview route: /pricing");

    await page.getByTestId("wb-preview-back").click();
    await expect(frame.locator("#heading")).toHaveText("Preview route: /");

    await page.getByTestId("wb-preview-reload").click();
    await expect(frame.locator("#reloads")).toHaveText("1");

    // Viewport preset switches to mobile 390px cleanly.
    await page.getByTestId("wb-preview-viewport-mobile").click();
    await expect(previewPane).toHaveAttribute("data-viewport-preset", "mobile");

    // Switch to bridge-less Remote preview mode (Consumer 3 / Fregat localhost style).
    await page.getByTestId("toggle-preview-mode").click();
    await expect(previewPane).toHaveAttribute("data-bridge-state", "bridgeless", { timeout: 10000 });
    await expect(frame.locator("#remote-heading")).toHaveText("Remote route: /");

    await urlInput.fill("/status");
    await urlInput.press("Enter");
    await expect(frame.locator("#remote-heading")).toHaveText("Remote route: /status");

    expect(errors).toEqual([]);
  });
}
