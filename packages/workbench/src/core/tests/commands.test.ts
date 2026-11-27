import { describe, expect, test } from "vitest";
import { createCommandRegistry, createDefaultHotkeyAdapter } from "../commands";

describe("commands and default HotkeyAdapter", () => {
  test("registers commands, supports binding overrides, formats hints, and detects EditContext", async () => {
    const registry = createCommandRegistry();
    let ran = 0;
    const adapter = createDefaultHotkeyAdapter({
      registry,
      platform: "mac",
      resolveOverrides: (id) => (id === "workbench.toggleExplorer" ? ["Mod+Shift+E"] : undefined),
    });

    const unregister = adapter.registerCommands([
      {
        id: "workbench.toggleExplorer",
        label: "Toggle Explorer",
        defaultBinding: "Mod+B",
        run: () => {
          ran += 1;
        },
      },
    ]);

    expect(adapter.getBindings("workbench.toggleExplorer")).toEqual(["Mod+Shift+E"]);
    expect(adapter.formatHint("workbench.toggleExplorer")).toContain("E");
    expect(await registry.execute("workbench.toggleExplorer")).toBe(true);
    expect(ran).toBe(1);

    const editContextHost = document.createElement("div");
    Object.defineProperty(editContextHost, "editContext", { value: {}, configurable: true });
    expect(adapter.isTextEntryTarget(editContextHost)).toBe(true);

    unregister();
    expect(registry.get("workbench.toggleExplorer")).toBeUndefined();
  });
});
