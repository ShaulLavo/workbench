import type { MouseEvent, ReactNode } from "react";
import {
  dismissSoftKeyboardOnTouchActivation,
  resolveActivationFocus,
  type ActivationFocusDecision,
  type EditorTabDescriptor,
  type GroupId,
  type TabId,
} from "@shaulavo/workbench-core";
import type { FileIconPreset } from "@shaulavo/workbench-icons";
import { FileTypeIcon } from "@shaulavo/workbench-icons/react";
import { BarTab, BarTabStrip } from "@shaulavo/workbench-ui";

export interface EditorTabBarProps {
  readonly groupId: GroupId;
  readonly tabs: readonly EditorTabDescriptor[];
  readonly selectedTabId: TabId | null;
  readonly iconPreset?: FileIconPreset;
  readonly actions?: ReactNode;
  readonly onSelectTab: (groupId: GroupId, tabId: TabId, focus: ActivationFocusDecision) => void;
  readonly onCloseTab: (groupId: GroupId, tabId: TabId) => void;
  readonly onPinTab?: (groupId: GroupId, tabId: TabId) => void;
  readonly onTabContextMenu?: (tab: EditorTabDescriptor, event: MouseEvent<HTMLDivElement>) => void;
  readonly className?: string;
}

/**
 * Editor tab strip enforcing per-activation touch focus policy: tapping a file tab on touch/coarse
 * viewports never focuses Singapore's editor input and dismisses any open soft keyboard.
 */
export function EditorTabBar({
  groupId,
  tabs,
  selectedTabId,
  iconPreset = "rich",
  actions,
  onSelectTab,
  onCloseTab,
  onPinTab,
  onTabContextMenu,
  className,
}: EditorTabBarProps) {
  function handleActivate(
    tab: EditorTabDescriptor,
    decision: ActivationFocusDecision,
    event: MouseEvent<HTMLButtonElement>,
  ): void {
    const resolved = decision ?? resolveActivationFocus(event, "auto");
    if (!resolved.shouldFocusEditor) {
      dismissSoftKeyboardOnTouchActivation(resolved, event.currentTarget);
    }
    onSelectTab(groupId, tab.id, resolved);
  }

  return (
    <BarTabStrip label="Open editors" actions={actions} className={className}>
      {tabs.map((tab) => {
        const active = tab.id === selectedTabId;
        return (
          <BarTab
            key={tab.id}
            active={active}
            label={tab.label}
            title={tab.title}
            preview={tab.preview}
            dirty={tab.dirty}
            data-testid={`wb-editor-tab-${tab.id}`}
            data-tab-kind={tab.kind}
            icon={<FileTypeIcon entry={{ name: tab.path ?? tab.label, type: "file" }} preset={iconPreset} />}
            onActivate={(focus, event) => handleActivate(tab, focus, event)}
            onDoubleClickLabel={tab.preview && onPinTab ? () => onPinTab(groupId, tab.id) : undefined}
            onClose={() => onCloseTab(groupId, tab.id)}
            onMouseDown={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onCloseTab(groupId, tab.id);
              }
            }}
            onContextMenu={onTabContextMenu ? (event) => onTabContextMenu(tab, event) : undefined}
          />
        );
      })}
    </BarTabStrip>
  );
}
