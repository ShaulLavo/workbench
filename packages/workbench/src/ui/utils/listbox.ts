export type ListboxKeyAction =
  | { readonly kind: "move"; readonly index: number }
  | { readonly kind: "commit" | "none" };

export interface ListboxKeyInput {
  readonly key: string;
  readonly count: number;
  readonly activeIndex: number;
  readonly pageSize?: number;
  readonly loop?: boolean;
}

/** Pure keyboard action resolver for vertical command lists and search results. */
export function resolveListboxKeyAction(input: ListboxKeyInput): ListboxKeyAction {
  const { key, count, activeIndex, pageSize = 10, loop = true } = input;
  if (count <= 0) return { kind: "none" };
  const clamped = Math.max(0, Math.min(count - 1, activeIndex));

  if (key === "ArrowDown") {
    const next = activeIndex < 0 ? 0 : activeIndex + 1;
    if (next >= count) return { kind: "move", index: loop ? 0 : count - 1 };
    return { kind: "move", index: next };
  }
  if (key === "ArrowUp") {
    if (activeIndex <= 0) return { kind: "move", index: loop ? count - 1 : 0 };
    return { kind: "move", index: activeIndex - 1 };
  }
  if (key === "Home") return { kind: "move", index: 0 };
  if (key === "End") return { kind: "move", index: count - 1 };
  if (key === "PageDown")
    return { kind: "move", index: Math.min(count - 1, clamped + Math.max(1, pageSize)) };
  if (key === "PageUp") return { kind: "move", index: Math.max(0, clamped - Math.max(1, pageSize)) };
  if (key === "Enter") return { kind: "commit" };
  return { kind: "none" };
}
