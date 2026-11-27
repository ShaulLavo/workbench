import { useState, type ReactNode } from "react";
import type {
  ActivationFocusDecision,
  DocumentId,
  EditorDocumentAdapter,
  EditorGroupAdapter,
  EditorGroupNode,
  EditorGroupTreeNode,
  GroupId,
  TabId,
} from "../core/index";
import { useSubscribable } from "../core/react/index";
import type { ThemeVersionSource } from "../tokens/index";
import { cx } from "../ui/index";
import type { Editor } from "@singapore-editor/core/editor";
import type { EditorPlugin } from "@singapore-editor/core/extensions";
import type { HighlightingService, HighlightingThemeSource } from "@singapore-editor/highlighting";
import { EditorTabBar } from "./editor-tab-bar";
import { EditorView } from "./editor-view";

export interface EditorWorkbenchProps {
  readonly documents: EditorDocumentAdapter;
  readonly groups: EditorGroupAdapter;
  /** Optional explicit group ID to render; defaults to `groups.activeGroupId`. */
  readonly groupId?: GroupId;
  readonly active?: boolean;
  readonly themeVersion?: ThemeVersionSource;
  readonly fontSize?: number;
  readonly lineHeight?: number;
  readonly wordWrap?: boolean;
  readonly highlightingService?: HighlightingService | null;
  readonly highlightingTheme?: HighlightingThemeSource;
  readonly extraPlugins?: readonly EditorPlugin[];
  readonly tabActions?: ReactNode;
  readonly overlay?: ReactNode;
  readonly emptyTitle?: string;
  readonly emptyDescription?: string;
  readonly onDirtyChange?: (documentId: DocumentId, dirty: boolean) => void;
  readonly onSave?: (documentId: DocumentId) => void;
  readonly onEditorReady?: (editor: Editor | null) => void;
  readonly className?: string;
}

function findGroupById(node: EditorGroupTreeNode, id: GroupId): EditorGroupNode | null {
  if (node.kind === "group") return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findGroupById(child.node, id);
    if (found) return found;
  }
  return null;
}

function findFirstGroup(node: EditorGroupTreeNode): EditorGroupNode {
  if (node.kind === "group") return node;
  return findFirstGroup(node.children[0].node);
}

/**
 * Complete single-group editor workbench combining `EditorTabBar` and `EditorView` with
 * per-activation touch focus handoff and empty state.
 */
export function EditorWorkbench({
  documents,
  groups,
  groupId,
  active = true,
  themeVersion,
  fontSize,
  lineHeight,
  wordWrap,
  highlightingService,
  highlightingTheme,
  extraPlugins,
  tabActions,
  overlay,
  emptyTitle = "No file open",
  emptyDescription = "Select a file from the explorer to start editing.",
  onDirtyChange,
  onSave,
  onEditorReady,
  className,
}: EditorWorkbenchProps) {
  const snapshot = useSubscribable(groups.groups);
  const targetId = groupId ?? snapshot.activeGroupId;
  const group = findGroupById(snapshot.root, targetId) ?? findFirstGroup(snapshot.root);
  const selectedTab = group.tabs.find((tab) => tab.id === group.selectedTabId) ?? group.tabs[0] ?? null;

  const [focusRequest, setFocusRequest] = useState<{
    readonly decision: ActivationFocusDecision | undefined;
    readonly seq: number;
  }>({ decision: undefined, seq: 0 });

  function handleSelectTab(targetGroupId: GroupId, tabId: TabId, focus: ActivationFocusDecision): void {
    setFocusRequest((prev) => ({ decision: focus, seq: prev.seq + 1 }));
    groups.selectTab(targetGroupId, tabId, focus);
  }

  return (
    <div
      data-wb-editor-workbench=""
      data-group-id={group.id}
      data-active-group={snapshot.activeGroupId === group.id ? "true" : "false"}
      className={cx("wb-editor-workbench", className)}
      onPointerDown={() => groups.setActiveGroup?.(group.id)}
    >
      <EditorTabBar
        groupId={group.id}
        tabs={group.tabs}
        selectedTabId={selectedTab?.id ?? null}
        actions={tabActions}
        onSelectTab={handleSelectTab}
        onCloseTab={(gid, tid) => groups.closeTabs(gid, [tid])}
        onPinTab={(gid, tid) => groups.pinTab(gid, tid)}
      />

      <div className="wb-editor-body">
        {selectedTab ? (
          <EditorView
            adapter={documents}
            documentId={selectedTab.documentId}
            path={selectedTab.path}
            active={active}
            readOnly={selectedTab.readOnly}
            focusDecision={focusRequest.decision}
            focusSeq={focusRequest.seq}
            themeVersion={themeVersion}
            fontSize={fontSize}
            lineHeight={lineHeight}
            wordWrap={wordWrap}
            highlightingService={highlightingService}
            highlightingTheme={highlightingTheme}
            extraPlugins={extraPlugins}
            onDirtyChange={onDirtyChange}
            onSave={onSave}
            onEditorReady={onEditorReady}
          />
        ) : (
          <div className="wb-editor-state" data-testid="wb-editor-empty">
            <strong>{emptyTitle}</strong>
            <p>{emptyDescription}</p>
          </div>
        )}
        {overlay}
      </div>
    </div>
  );
}
