import type { Subscribable } from "../subscribable";

export type WorkbenchPaneId = "explorer" | "editor" | "preview" | "terminal" | "chat" | "search";

export interface GlobalPaneGeometry {
  readonly explorerWidthPx: number;
  readonly previewFraction: number;
  readonly terminalHeightPx: number;
  readonly explorerOpen: boolean;
  readonly previewOpen: boolean;
  readonly terminalOpen: boolean;
}

export interface LayoutAdapter {
  readonly geometry: Subscribable<GlobalPaneGeometry>;
  setGeometry(next: GlobalPaneGeometry): void;
  /** Commits geometry to persistent global storage (never per-workspace). */
  commitGeometry(): void;
  readonly mobileActivePane: Subscribable<WorkbenchPaneId>;
  setMobileActivePane(pane: WorkbenchPaneId): void;
  /** Optional per-workspace scroll/expansion persistence. */
  readWorkspaceState?<T>(key: string): T | undefined;
  writeWorkspaceState?<T>(key: string, value: T): void;
}
