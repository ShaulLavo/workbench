import { detectPlatform, formatForDisplay, type RegisterableHotkey } from "@shaulavo/hotkeys";
import type { HotkeyAdapter, WorkbenchCommand } from "./adapters/hotkeys";
import { isEditableTextSurface } from "./focus-policy";
import { createSubscribable, type Subscribable } from "./subscribable";

export interface CommandRegistry {
  readonly commands: Subscribable<readonly WorkbenchCommand[]>;
  register(commands: readonly WorkbenchCommand[]): () => void;
  get(id: string): WorkbenchCommand | undefined;
  execute(id: string): Promise<boolean>;
}

export function createCommandRegistry(): CommandRegistry {
  const byId = new Map<string, WorkbenchCommand>();
  const store = createSubscribable<readonly WorkbenchCommand[]>([]);

  const emit = (): void => {
    store.set(Array.from(byId.values()));
  };

  return {
    commands: store,
    register(entries) {
      for (const entry of entries) byId.set(entry.id, entry);
      emit();
      return () => {
        let changed = false;
        for (const entry of entries) {
          if (byId.get(entry.id) === entry) {
            byId.delete(entry.id);
            changed = true;
          }
        }
        if (changed) emit();
      };
    },
    get: (id) => byId.get(id),
    async execute(id) {
      const command = byId.get(id);
      if (!command) return false;
      if (command.enabled && !command.enabled()) return false;
      await command.run();
      return true;
    },
  };
}

export interface DefaultHotkeyAdapterOptions {
  readonly registry?: CommandRegistry;
  /** Optional binding overrides (e.g. Fregat user preset bindings). */
  readonly resolveOverrides?: (commandId: string) => readonly string[] | undefined;
  readonly platform?: "mac" | "windows" | "linux";
}

function normalizeBindings(binding: string | readonly string[] | undefined): readonly string[] {
  if (!binding) return [];
  return typeof binding === "string" ? [binding] : binding;
}

/**
 * Default backend-neutral `HotkeyAdapter` built on `@shaulavo/hotkeys` with EditContext-aware
 * text-entry detection (fixes Fregat Plan 171 row 21 where `isContentEditable` is false).
 */
export function createDefaultHotkeyAdapter(options?: DefaultHotkeyAdapterOptions): HotkeyAdapter {
  const registry = options?.registry ?? createCommandRegistry();
  const platform = options?.platform ?? detectPlatform();

  const getBindings = (commandId: string): readonly string[] => {
    const override = options?.resolveOverrides?.(commandId);
    if (override) return override;
    return normalizeBindings(registry.get(commandId)?.defaultBinding);
  };

  return {
    registerCommands: (commands) => registry.register(commands),
    getBindings,
    formatHint(commandId) {
      const first = getBindings(commandId)[0];
      if (!first) return undefined;
      try {
        return formatForDisplay(first as RegisterableHotkey, { platform });
      } catch {
        return first;
      }
    },
    isTextEntryTarget: (target) => isEditableTextSurface(target),
  };
}
