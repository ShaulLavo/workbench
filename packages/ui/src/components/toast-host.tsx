import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Subscribable } from "@shaulavo/workbench-core";
import { useSubscribable } from "@shaulavo/workbench-core/react";
import { StrokeIcon } from "@shaulavo/workbench-icons/react";
import { useWorkbenchPortalContainer } from "./portal";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastInput {
  readonly id?: string;
  readonly tone?: ToastTone;
  readonly title: string;
  readonly description?: string;
  readonly durationMs?: number;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}

export interface ToastItem {
  readonly id: string;
  readonly tone: ToastTone;
  readonly title: string;
  readonly description?: string;
  readonly durationMs: number;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}

export interface ToastStore extends Subscribable<readonly ToastItem[]> {
  push(input: ToastInput): string;
  dismiss(id: string): void;
  clear(): void;
}

const DEFAULT_DURATION_MS = 4500;

/** Creates an isolated toast notification store compatible with `ToastHost`. */
export function createToastStore(): ToastStore {
  let items: readonly ToastItem[] = [];
  let seq = 0;
  const listeners = new Set<() => void>();

  function emit(): void {
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot() {
      return items;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push(input) {
      seq += 1;
      const id = input.id ?? `wb-toast-${seq}`;
      const nextItem: ToastItem = {
        id,
        tone: input.tone ?? "info",
        title: input.title,
        description: input.description,
        durationMs: input.durationMs ?? DEFAULT_DURATION_MS,
        action: input.action,
      };
      items = items.filter((item) => item.id !== id).concat([nextItem]);
      emit();
      return id;
    },
    dismiss(id) {
      const next = items.filter((item) => item.id !== id);
      if (next.length === items.length) return;
      items = next;
      emit();
    },
    clear() {
      if (items.length === 0) return;
      items = [];
      emit();
    },
  };
}

/** Default shared toast store for zero-ceremony imperative notifications. */
export const workbenchToast: ToastStore = createToastStore();

export interface ToastHostProps {
  readonly store?: ToastStore;
  readonly portalContainer?: HTMLElement | null;
}

function toneIcon(tone: ToastTone): "info" | "check" | "warning" | "error" {
  if (tone === "success") return "check";
  if (tone === "warning") return "warning";
  if (tone === "error") return "error";
  return "info";
}

function ToastCard({
  item,
  paused,
  onDismiss,
}: {
  readonly item: ToastItem;
  readonly paused: boolean;
  readonly onDismiss: (id: string) => void;
}) {
  useEffect(() => {
    if (paused || item.durationMs <= 0) return;
    const handle = window.setTimeout(() => onDismiss(item.id), item.durationMs);
    return () => window.clearTimeout(handle);
  }, [item.id, item.durationMs, paused, onDismiss]);

  return (
    <div
      role={item.tone === "error" ? "alert" : "status"}
      data-wb-toast=""
      data-tone={item.tone}
      data-testid={`wb-toast-${item.id}`}
      className="wb-toast"
    >
      <span className="wb-toast-icon" aria-hidden="true">
        <StrokeIcon name={toneIcon(item.tone)} />
      </span>
      <div className="wb-toast-copy">
        <div className="wb-toast-title">{item.title}</div>
        {item.description ? <div className="wb-toast-description">{item.description}</div> : null}
      </div>
      {item.action ? (
        <button
          type="button"
          className="wb-toast-action"
          onClick={() => {
            item.action?.onClick();
            onDismiss(item.id);
          }}
        >
          {item.action.label}
        </button>
      ) : null}
      <button
        type="button"
        className="wb-toast-close"
        aria-label="Dismiss notification"
        onClick={() => onDismiss(item.id)}
      >
        <StrokeIcon name="close" />
      </button>
    </div>
  );
}

/**
 * Portaled toast stack inheriting scoped `--wb-*` theme tokens. Pauses auto-dismiss while hovered
 * or when the document tab is hidden.
 */
export function ToastHost({ store = workbenchToast, portalContainer }: ToastHostProps) {
  const items = useSubscribable(store);
  const container = useWorkbenchPortalContainer(portalContainer);
  const [hovered, setHovered] = useState(false);
  const [hidden, setHidden] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden",
  );

  useEffect(() => {
    const sync = (): void => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, []);

  if (items.length === 0) return null;

  const stack = (
    <div
      data-wb-toast-host=""
      className="wb-toast-host"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {items.map((item) => (
        <ToastCard key={item.id} item={item} paused={hovered || hidden} onDismiss={store.dismiss} />
      ))}
    </div>
  );

  const target = container ?? (typeof document !== "undefined" ? document.body : null);
  return target ? createPortal(stack, target) : stack;
}
