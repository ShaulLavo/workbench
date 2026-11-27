import type { Ref } from "react";

/** Forwards a DOM node to either a callback ref (preserving React 19 cleanup) or a mutable RefObject. */
export function forwardDomRef<T>(ref: Ref<T> | undefined, node: T | null): (() => void) | void {
  if (!ref) return;
  if (typeof ref === "function") return ref(node);
  ref.current = node;
}
