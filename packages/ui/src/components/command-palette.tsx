import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import type { HotkeyAdapter, WorkbenchCommand } from "@shaulavo/workbench-core";
import { StrokeIcon } from "@shaulavo/workbench-icons/react";
import { resolveListboxKeyAction } from "../utils/listbox";
import { Kbd } from "./kbd";
import { useWorkbenchPortalContainer } from "./portal";

export interface CommandPaletteItem {
  readonly id: string;
  readonly label: string;
  readonly category?: string;
  readonly detail?: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
  readonly disabled?: boolean;
  readonly isEnabled?: () => boolean;
  readonly onSelect: () => void;
}

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly commands?: readonly WorkbenchCommand[];
  readonly items?: readonly CommandPaletteItem[];
  readonly hotkeys?: Pick<HotkeyAdapter, "formatHint">;
  /** Optional revision token from a mutable command registry to force availability re-evaluation while open. */
  readonly availabilityKey?: unknown;
  readonly placeholder?: string;
  readonly emptyLabel?: string;
  readonly title?: string;
  readonly portalContainer?: HTMLElement | null;
}

function matchesQuery(item: CommandPaletteItem, query: string): boolean {
  if (!query) return true;
  const hay = `${item.category ?? ""} ${item.label} ${item.detail ?? ""}`.toLocaleLowerCase();
  const terms = query.trim().toLocaleLowerCase().split(/\s+/);
  for (const term of terms) {
    if (!term) continue;
    if (!hay.includes(term)) return false;
  }
  return true;
}

function collectVisibleItems(
  open: boolean,
  query: string,
  availabilityKey: unknown,
  items: readonly CommandPaletteItem[] | undefined,
  commands: readonly WorkbenchCommand[] | undefined,
  hotkeys: Pick<HotkeyAdapter, "formatHint"> | undefined,
): readonly CommandPaletteItem[] {
  void availabilityKey;
  if (!open) return [];
  const source: readonly CommandPaletteItem[] =
    items ??
    (commands ?? []).map((command) => ({
      id: command.id,
      label: command.label,
      category: command.category,
      hint: hotkeys?.formatHint(command.id),
      isEnabled: command.enabled,
      onSelect: () => {
        void command.run();
      },
    }));

  const visible: CommandPaletteItem[] = [];
  for (const item of source) {
    if (item.disabled) continue;
    if (item.isEnabled && !item.isEnabled()) continue;
    if (!matchesQuery(item, query)) continue;
    visible.push(item);
  }
  return visible;
}

/**
 * Keyboard-driven command palette built on Base UI `Dialog` and portaled into the active theme
 * scope. Re-evaluates command availability on open, query change, and dispatch, and scrolls the
 * active option into view during keyboard navigation.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
  items,
  hotkeys,
  availabilityKey,
  placeholder = "Type a command…",
  emptyLabel = "No matching commands",
  title = "Command palette",
  portalContainer,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listId = useId();
  const container = useWorkbenchPortalContainer(portalContainer);

  const filtered = collectVisibleItems(open, query, availabilityKey, items, commands, hotkeys);
  const safeActiveIndex = filtered.length === 0 ? -1 : Math.min(activeIndex, filtered.length - 1);
  const activeOptionId = safeActiveIndex >= 0 ? `${listId}-opt-${safeActiveIndex}` : undefined;

  useEffect(() => {
    if (!open || !activeOptionId) return;
    document.getElementById(activeOptionId)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeOptionId]);

  function handleOpenChange(nextOpen: boolean): void {
    setQuery("");
    setActiveIndex(0);
    onOpenChange(nextOpen);
  }

  function runItem(item: CommandPaletteItem): void {
    if (item.disabled || (item.isEnabled && !item.isEnabled())) return;
    handleOpenChange(false);
    item.onSelect();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const action = resolveListboxKeyAction({
      key: event.key,
      count: filtered.length,
      activeIndex: safeActiveIndex,
    });
    if (action.kind === "move") {
      event.preventDefault();
      setActiveIndex(action.index);
      return;
    }
    if (action.kind === "commit" && safeActiveIndex >= 0) {
      event.preventDefault();
      const target = filtered[safeActiveIndex];
      if (target) runItem(target);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal container={container}>
        <Dialog.Backdrop className="wb-palette-backdrop" />
        <Dialog.Popup className="wb-palette-popup" initialFocus={inputRef} data-testid="wb-command-palette">
          <Dialog.Title className="wb-sr-only">{title}</Dialog.Title>
          <div className="wb-palette-input-row">
            <StrokeIcon name="search" className="wb-palette-search-icon" />
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeOptionId}
              aria-label={title}
              className="wb-palette-input"
              placeholder={placeholder}
              value={query}
              data-testid="wb-command-palette-input"
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleKeyDown}
            />
          </div>
          <div id={listId} role="listbox" aria-label={title} className="wb-palette-list">
            {filtered.length === 0 ? (
              <div className="wb-palette-empty" role="status">
                {emptyLabel}
              </div>
            ) : (
              filtered.map((item, index) => {
                const isActive = index === safeActiveIndex;
                return (
                  <button
                    key={item.id}
                    id={`${listId}-opt-${index}`}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-active={isActive ? "true" : "false"}
                    data-testid={`wb-palette-item-${item.id}`}
                    className="wb-palette-item"
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => runItem(item)}
                  >
                    {item.icon ? (
                      <span className="wb-palette-item-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                    ) : null}
                    <span className="wb-palette-item-text">
                      {item.category ? <span className="wb-palette-category">{item.category}:</span> : null}
                      <span className="wb-palette-label">{item.label}</span>
                      {item.detail ? <span className="wb-palette-detail">{item.detail}</span> : null}
                    </span>
                    {item.hint ? <Kbd>{item.hint}</Kbd> : null}
                  </button>
                );
              })
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
