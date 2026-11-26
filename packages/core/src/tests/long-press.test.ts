import { afterEach, describe, expect, it, vi } from "vitest";
import { attachLongPressContextMenu } from "../long-press";

describe("attachLongPressContextMenu", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("skips targets owned by a native long-press trigger such as Base UI ContextMenu", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    const nativeTrigger = document.createElement("div");
    nativeTrigger.dataset.wbNativeLongPress = "true";
    const child = document.createElement("button");
    nativeTrigger.appendChild(child);
    root.appendChild(nativeTrigger);
    document.body.appendChild(root);

    const onContext = vi.fn();
    child.addEventListener("contextmenu", onContext);
    const detach = attachLongPressContextMenu(root, { delayMs: 200 });

    child.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerType: "touch",
        isPrimary: true,
        pointerId: 1,
        clientX: 10,
        clientY: 10,
        bubbles: true,
      }),
    );
    vi.advanceTimersByTime(300);

    expect(onContext).not.toHaveBeenCalled();
    detach();
  });

  it("scopes post-long-press click suppression strictly to the originating gesture target", () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    const row = document.createElement("button");
    row.style.userSelect = "none";
    const otherButton = document.createElement("button");
    root.appendChild(row);
    root.appendChild(otherButton);
    document.body.appendChild(root);

    const onRowContext = vi.fn();
    const onRowClick = vi.fn();
    const onOtherClick = vi.fn();
    row.addEventListener("contextmenu", onRowContext);
    row.addEventListener("click", onRowClick);
    otherButton.addEventListener("click", onOtherClick);

    const detach = attachLongPressContextMenu(root, { delayMs: 200, dedupMs: 700 });

    row.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerType: "touch",
        isPrimary: true,
        pointerId: 1,
        clientX: 12,
        clientY: 12,
        bubbles: true,
      }),
    );
    vi.advanceTimersByTime(250);
    expect(onRowContext).toHaveBeenCalledTimes(1);

    // An immediate click on an unrelated button inside the shell is NOT swallowed.
    otherButton.click();
    expect(onOtherClick).toHaveBeenCalledTimes(1);

    // Clicking the originating target within the dedup window IS suppressed once.
    row.click();
    expect(onRowClick).toHaveBeenCalledTimes(0);

    // Subsequent click on the originating target works normally.
    row.click();
    expect(onRowClick).toHaveBeenCalledTimes(1);

    detach();
  });
});
