import { describe, expect, test } from "vitest";
import { observeWorkbenchTheme, parseCssColor, resolveColorScheme } from "../index";

describe("parseCssColor", () => {
  test("parses rgb, rgba, color(srgb), and hex formats", () => {
    expect(parseCssColor("rgb(26, 75, 224)")).toEqual({ r: 26, g: 75, b: 224 });
    expect(parseCssColor("rgba(10, 13, 20, 0.8)")).toEqual({ r: 10, g: 13, b: 20 });
    expect(parseCssColor("color(srgb 1 0.5 0)")).toEqual({ r: 255, g: 128, b: 0 });
    expect(parseCssColor("#1a4be0")).toEqual({ r: 26, g: 75, b: 224 });
    expect(parseCssColor("#0af")).toEqual({ r: 0, g: 170, b: 255 });
    expect(parseCssColor("not-a-color")).toBeUndefined();
  });
});

describe("resolveColorScheme & observeWorkbenchTheme", () => {
  test("resolves scoped data-theme over root and notifies on both root and scope changes", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const scope = document.createElement("div");
    scope.setAttribute("data-wb-theme-scope", "");
    scope.setAttribute("data-theme", "light");
    const child = document.createElement("div");
    scope.appendChild(child);
    document.body.appendChild(scope);

    expect(resolveColorScheme(child)).toBe("light");

    let changes = 0;
    const listeners = new Set<() => void>();
    const dispose = observeWorkbenchTheme(
      child,
      () => {
        changes += 1;
      },
      {
        themeVersion: {
          subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      },
    );

    scope.setAttribute("data-theme", "dark");
    await Promise.resolve();
    expect(resolveColorScheme(child)).toBe("dark");
    expect(changes).toBeGreaterThanOrEqual(1);

    const beforeVersion = changes;
    for (const listener of listeners) listener();
    expect(changes).toBe(beforeVersion + 1);

    dispose();
    scope.remove();
    document.documentElement.removeAttribute("data-theme");
  });
});
