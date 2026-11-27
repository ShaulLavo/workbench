import { describe, expect, test } from "vitest";
import {
  dismissSoftKeyboardOnTouchActivation,
  isEditableTextSurface,
  resolveActivationFocus,
} from "../focus-policy";

describe("focus-policy", () => {
  test("never focuses editor on touch activation unless explicitly forced", () => {
    const touchEvent = new Event("pointerdown") as PointerEvent;
    Object.defineProperty(touchEvent, "pointerType", { value: "touch" });

    expect(resolveActivationFocus(touchEvent, "auto", { coarseViewport: false })).toEqual({
      shouldFocusEditor: false,
      origin: "touch",
    });
    expect(resolveActivationFocus(touchEvent, "always", { coarseViewport: true })).toEqual({
      shouldFocusEditor: true,
      origin: "touch",
    });
  });

  test("focuses editor on desktop mouse and keyboard activation, suppresses on coarse mouse clicks", () => {
    const mouseClick = new MouseEvent("click", { detail: 1 });
    expect(resolveActivationFocus(mouseClick, "auto", { coarseViewport: false })).toEqual({
      shouldFocusEditor: true,
      origin: "mouse",
    });
    expect(resolveActivationFocus(mouseClick, "auto", { coarseViewport: true })).toEqual({
      shouldFocusEditor: false,
      origin: "touch",
    });

    const keyboardClick = new MouseEvent("click", { detail: 0 });
    expect(resolveActivationFocus(keyboardClick, "auto", { coarseViewport: true })).toEqual({
      shouldFocusEditor: true,
      origin: "keyboard",
    });
  });

  test("detects EditContext hosts where isContentEditable is false", () => {
    const div = document.createElement("div");
    expect(isEditableTextSurface(div)).toBe(false);
    Object.defineProperty(div, "editContext", { value: {}, configurable: true });
    expect(isEditableTextSurface(div)).toBe(true);
  });

  test("blurs open text input on touch tab tap and moves focus to non-text fallback", () => {
    const input = document.createElement("textarea");
    const tab = document.createElement("button");
    tab.type = "button";
    document.body.append(input, tab);
    input.focus();
    expect(document.activeElement).toBe(input);

    dismissSoftKeyboardOnTouchActivation({ shouldFocusEditor: false, origin: "touch" }, tab);
    expect(document.activeElement).toBe(tab);

    input.remove();
    tab.remove();
  });
});
