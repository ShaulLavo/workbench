export type ActivationOrigin = "mouse" | "keyboard" | "touch" | "pen" | "programmatic";

export type FocusPreference = "auto" | "always" | "never";

export interface ActivationFocusDecision {
  /** Immutable per-activation decision carried through async loads and overlay closes. */
  readonly shouldFocusEditor: boolean;
  readonly origin: ActivationOrigin;
}

let trackedPointerOrigin: "mouse" | "touch" | "pen" | undefined;
let trackingAttached = false;

function handleGlobalPointerDown(event: PointerEvent): void {
  if (event.pointerType === "touch" || event.pointerType === "pen" || event.pointerType === "mouse") {
    trackedPointerOrigin = event.pointerType;
  }
}

function handleGlobalKeyDown(): void {
  trackedPointerOrigin = undefined;
}

/** Installs capture listeners to remember the most recent pointer type for `click` events lacking `pointerType`. */
export function ensurePointerModalityTracking(): void {
  if (trackingAttached || typeof window === "undefined") return;
  trackingAttached = true;
  window.addEventListener("pointerdown", handleGlobalPointerDown, { capture: true, passive: true });
  window.addEventListener("keydown", handleGlobalKeyDown, { capture: true, passive: true });
}

export function isCoarsePointerViewport(): boolean {
  return typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

export function detectActivationOrigin(
  event?: Event | { readonly nativeEvent?: Event },
  coarseViewport?: boolean,
): ActivationOrigin {
  const native = event && "nativeEvent" in event ? event.nativeEvent : event;
  if (!native) return trackedPointerOrigin ?? "programmatic";
  if (typeof KeyboardEvent !== "undefined" && native instanceof KeyboardEvent) return "keyboard";
  if ("pointerType" in native) {
    const type = (native as PointerEvent).pointerType;
    if (type === "touch" || type === "pen" || type === "mouse") return type;
  }
  if (typeof MouseEvent !== "undefined" && native instanceof MouseEvent) {
    // Keyboard activation of a <button> dispatches a synthetic click with detail === 0.
    if (native.detail === 0) return "keyboard";
    return trackedPointerOrigin ?? ((coarseViewport ?? isCoarsePointerViewport()) ? "touch" : "mouse");
  }
  return trackedPointerOrigin ?? "programmatic";
}

/**
 * Resolves a concrete per-activation focus decision.
 * Touch/coarse activations never focus the editor automatically (preventing iOS soft keyboard pop
 * on file-tab tap, tree file tap, or pane switch) unless `preference` is explicitly `"always"`.
 */
export function resolveActivationFocus(
  event?: Event | { readonly nativeEvent?: Event },
  preference: FocusPreference = "auto",
  options?: { readonly coarseViewport?: boolean },
): ActivationFocusDecision {
  const coarse = options?.coarseViewport ?? isCoarsePointerViewport();
  const origin = detectActivationOrigin(event, coarse);
  if (preference === "always") return { shouldFocusEditor: true, origin };
  if (preference === "never") return { shouldFocusEditor: false, origin };

  if (origin === "touch" || (coarse && origin !== "keyboard")) {
    return { shouldFocusEditor: false, origin };
  }
  return { shouldFocusEditor: true, origin };
}

/**
 * Checks whether an element is a text-entry surface (including EditContext hosts where
 * `isContentEditable` is false, such as Singapore editors).
 */
export function isEditableTextSurface(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  if (target.isContentEditable) return true;
  if ("editContext" in target && (target as HTMLElement & { editContext?: unknown }).editContext != null) {
    return true;
  }
  const role = target.getAttribute("role");
  return role === "textbox" || role === "searchbox" || role === "combobox";
}

/**
 * On touch/coarse tab or tree taps when the software keyboard is already open in an editor or
 * terminal, blurs the text surface and optionally focuses a non-text container with `preventScroll`
 * so the keyboard dismisses and does not obscure the newly opened file.
 */
export function dismissSoftKeyboardOnTouchActivation(
  decision: ActivationFocusDecision,
  fallbackNonTextTarget?: HTMLElement | null,
): void {
  if (decision.shouldFocusEditor) return;
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && isEditableTextSurface(active)) {
    active.blur();
  }
  if (fallbackNonTextTarget && !isEditableTextSurface(fallbackNonTextTarget)) {
    fallbackNonTextTarget.focus({ preventScroll: true });
  }
}
