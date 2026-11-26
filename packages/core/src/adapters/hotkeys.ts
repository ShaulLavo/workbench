export type HotkeyScope = "workbench" | "tree" | "editor" | "terminal" | "preview" | "overlay";

export interface WorkbenchCommand {
  readonly id: string;
  readonly label: string;
  readonly category?: string;
  readonly defaultBinding?: string | readonly string[];
  readonly scope?: HotkeyScope;
  readonly enabled?: () => boolean;
  run(): void | Promise<void>;
}

export interface HotkeyAdapter {
  registerCommands(commands: readonly WorkbenchCommand[]): () => void;
  getBindings(commandId: string): readonly string[];
  formatHint(commandId: string): string | undefined;
  isTextEntryTarget(target: EventTarget | null): boolean;
  getTerminalParentScope?(): unknown;
}
