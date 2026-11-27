import { Fragment, useState, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { horizontalListSortingStrategy, SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  dismissSoftKeyboardOnTouchActivation,
  resolveActivationFocus,
  type ActivationFocusDecision,
  type EditorDocumentAdapter,
  type EditorGroupAdapter,
  type EditorGroupNode,
  type EditorGroupTreeNode,
  type EditorTabDescriptor,
  type GroupId,
  type TabId,
} from "../../core/index";
import { useSubscribable } from "../../core/react/index";
import { FileTypeIcon } from "../../icons/react";
import type { ThemeVersionSource } from "../../tokens/index";
import { BarTab, BarTabStrip, cx } from "../../ui/index";
import type { EditorPlugin } from "@singapore-editor/core/extensions";
import type { HighlightingService, HighlightingThemeSource } from "@singapore-editor/highlighting";
import { CodeEditor } from "../code-editor";
import type { GroupDropEdge } from "./model";

export interface EditorGroupLayoutProps {
  readonly documents: EditorDocumentAdapter;
  readonly groups: EditorGroupAdapter;
  readonly themeVersion?: ThemeVersionSource;
  readonly fontSize?: number;
  readonly lineHeight?: number;
  readonly wordWrap?: boolean;
  readonly highlighting?: false | HighlightingService;
  readonly highlightingTheme?: HighlightingThemeSource;
  readonly extraPlugins?: readonly EditorPlugin[];
  readonly renderTabActions?: (group: EditorGroupNode) => ReactNode;
  readonly renderGroupOverlay?: (group: EditorGroupNode) => ReactNode;
  readonly onDirtyChange?: (documentId: string, dirty: boolean) => void;
  readonly onSave?: (documentId: string) => void;
  readonly className?: string;
}

class NonTouchPointerSensor extends PointerSensor {
  static override activators = [
    {
      eventName: "onPointerDown" as const,
      handler({ nativeEvent }: { nativeEvent: PointerEvent }) {
        // Ignore touch pointers so horizontal swipe scrolls the tab strip cleanly.
        if (nativeEvent.pointerType === "touch") return false;
        if (nativeEvent.button !== 0) return false;
        return true;
      },
    },
  ];
}

interface SortableTabProps {
  readonly groupId: GroupId;
  readonly tab: EditorTabDescriptor;
  readonly active: boolean;
  readonly onSelect: (tab: EditorTabDescriptor, focus: ActivationFocusDecision, target: HTMLElement) => void;
  readonly onClose: (tabId: TabId) => void;
  readonly onPin: (tabId: TabId) => void;
}

function SortableEditorTab({ groupId, tab, active, onSelect, onClose, onPin }: SortableTabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: `tab:${groupId}:${tab.id}`,
    data: { kind: "editor-tab", groupId, tabId: tab.id },
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : undefined,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="wb-editor-sortable-tab">
      <BarTab
        active={active}
        label={tab.label}
        title={tab.title}
        preview={tab.preview}
        dirty={tab.dirty}
        data-testid={`wb-editor-tab-${tab.id}`}
        icon={<FileTypeIcon entry={{ name: tab.path ?? tab.label, type: "file" }} />}
        onActivate={(focus, event) => {
          const resolved = focus ?? resolveActivationFocus(event, "auto");
          onSelect(tab, resolved, event.currentTarget);
        }}
        onDoubleClickLabel={tab.preview ? () => onPin(tab.id) : undefined}
        onClose={() => onClose(tab.id)}
        onMouseDown={(event) => {
          if (event.button === 1) {
            event.preventDefault();
            onClose(tab.id);
          }
        }}
      />
    </div>
  );
}

function GroupEdgeDropTarget({
  groupId,
  edge,
}: {
  readonly groupId: GroupId;
  readonly edge: Exclude<GroupDropEdge, "center">;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `edge:${groupId}:${edge}`,
    data: { kind: "group-edge", groupId, edge },
  });
  return (
    <div
      ref={setNodeRef}
      data-wb-drop-edge={edge}
      data-over={isOver ? "true" : undefined}
      data-testid={`wb-group-edge-${groupId}-${edge}`}
      className={cx("wb-group-edge-zone", `wb-group-edge-${edge}`)}
    />
  );
}

interface LeafGroupProps {
  readonly group: EditorGroupNode;
  readonly activeGroupId: GroupId;
  readonly isDraggingTab: boolean;
  readonly documents: EditorDocumentAdapter;
  readonly groups: EditorGroupAdapter;
  readonly themeVersion?: ThemeVersionSource;
  readonly fontSize?: number;
  readonly lineHeight?: number;
  readonly wordWrap?: boolean;
  readonly highlighting?: false | HighlightingService;
  readonly highlightingTheme?: HighlightingThemeSource;
  readonly extraPlugins?: readonly EditorPlugin[];
  readonly renderTabActions?: (group: EditorGroupNode) => ReactNode;
  readonly renderGroupOverlay?: (group: EditorGroupNode) => ReactNode;
  readonly onDirtyChange?: (documentId: string, dirty: boolean) => void;
  readonly onSave?: (documentId: string) => void;
}

function EditorGroupPane({
  group,
  activeGroupId,
  isDraggingTab,
  documents,
  groups,
  themeVersion,
  fontSize,
  lineHeight,
  wordWrap,
  highlighting,
  highlightingTheme,
  extraPlugins,
  renderTabActions,
  renderGroupOverlay,
  onDirtyChange,
  onSave,
}: LeafGroupProps) {
  const { setNodeRef: setGroupDropRef, isOver: isOverGroup } = useDroppable({
    id: `group:${group.id}`,
    data: { kind: "group-body", groupId: group.id },
  });
  const [focusRequest, setFocusRequest] = useState<{
    readonly decision: ActivationFocusDecision | undefined;
    readonly seq: number;
  }>({ decision: undefined, seq: 0 });

  const selectedTab = group.tabs.find((t) => t.id === group.selectedTabId) ?? group.tabs[0] ?? null;
  const sortableIds = group.tabs.map((tab) => `tab:${group.id}:${tab.id}`);
  const isActiveGroup = group.id === activeGroupId;

  return (
    <div
      ref={setGroupDropRef}
      data-wb-editor-group={group.id}
      data-active-group={isActiveGroup ? "true" : "false"}
      data-drop-over={isOverGroup ? "true" : undefined}
      data-testid={`wb-editor-group-${group.id}`}
      className="wb-editor-group"
      onPointerDown={() => groups.setActiveGroup?.(group.id)}
    >
      <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
        <BarTabStrip label={`Editors in ${group.id}`} actions={renderTabActions?.(group)}>
          {group.tabs.map((tab) => (
            <SortableEditorTab
              key={tab.id}
              groupId={group.id}
              tab={tab}
              active={tab.id === selectedTab?.id}
              onSelect={(item, decision, target) => {
                if (!decision.shouldFocusEditor) {
                  dismissSoftKeyboardOnTouchActivation(decision, target);
                }
                setFocusRequest((prev) => ({ decision, seq: prev.seq + 1 }));
                groups.selectTab(group.id, item.id, decision);
              }}
              onClose={(tabId) => groups.closeTabs(group.id, [tabId])}
              onPin={(tabId) => groups.pinTab(group.id, tabId)}
            />
          ))}
        </BarTabStrip>
      </SortableContext>

      <div className="wb-editor-body">
        {selectedTab ? (
          <CodeEditor
            adapter={documents}
            documentId={selectedTab.documentId}
            path={selectedTab.path}
            active={isActiveGroup}
            readOnly={selectedTab.readOnly}
            focusDecision={focusRequest.decision}
            focusSeq={focusRequest.seq}
            themeVersion={themeVersion}
            fontSize={fontSize}
            lineHeight={lineHeight}
            wordWrap={wordWrap}
            highlighting={highlighting}
            highlightingTheme={highlightingTheme}
            extraPlugins={extraPlugins}
            onDirtyChange={onDirtyChange}
            onSave={onSave}
          />
        ) : (
          <div className="wb-editor-state" data-testid={`wb-editor-group-empty-${group.id}`}>
            <strong>Empty editor group</strong>
          </div>
        )}

        {isDraggingTab ? (
          <div className="wb-group-drop-overlay" data-testid={`wb-group-drop-overlay-${group.id}`}>
            <GroupEdgeDropTarget groupId={group.id} edge="left" />
            <GroupEdgeDropTarget groupId={group.id} edge="right" />
            <GroupEdgeDropTarget groupId={group.id} edge="top" />
            <GroupEdgeDropTarget groupId={group.id} edge="bottom" />
          </div>
        ) : null}

        {renderGroupOverlay?.(group)}
      </div>
    </div>
  );
}

/**
 * Multi-group recursive editor split layout with `@dnd-kit` tab reorder, cross-group move/copy
 * (hold Alt/Option to copy), and edge-split drop targets. Touch pointers are excluded from tab
 * dragging so horizontal swipe scrolls tabs naturally.
 */
export function EditorGroupLayout({
  documents,
  groups,
  themeVersion,
  fontSize,
  lineHeight,
  wordWrap,
  highlighting,
  highlightingTheme,
  extraPlugins,
  renderTabActions,
  renderGroupOverlay,
  onDirtyChange,
  onSave,
  className,
}: EditorGroupLayoutProps) {
  const snapshot = useSubscribable(groups.groups);
  const [draggingTabId, setDraggingTabId] = useState<TabId | null>(null);
  const sensors = useSensors(
    useSensor(NonTouchPointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );

  function handleDragStart(event: DragStartEvent): void {
    const data = event.active.data.current as { readonly tabId?: TabId } | undefined;
    setDraggingTabId(data?.tabId ?? null);
  }

  function handleDragEnd(event: DragEndEvent): void {
    setDraggingTabId(null);
    const activeData = event.active.data.current as
      | { readonly kind?: string; readonly tabId?: TabId }
      | undefined;
    const overData = event.over?.data.current as
      | {
          readonly kind?: string;
          readonly groupId?: GroupId;
          readonly tabId?: TabId;
          readonly edge?: Exclude<GroupDropEdge, "center">;
        }
      | undefined;
    if (!activeData?.tabId || !overData?.groupId) return;

    const activator = event.activatorEvent;
    const isCopy = typeof MouseEvent !== "undefined" && activator instanceof MouseEvent && activator.altKey;
    const mode = isCopy ? "copy" : "move";

    if (overData.kind === "group-edge" && overData.edge) {
      groups.placeTab({
        tabId: activeData.tabId,
        mode,
        target: { kind: "edge", groupId: overData.groupId, edge: overData.edge },
      });
      return;
    }

    if (overData.kind === "editor-tab" && overData.tabId) {
      if (overData.tabId === activeData.tabId && !isCopy) return;
      groups.placeTab({
        tabId: activeData.tabId,
        mode,
        target: { kind: "strip", groupId: overData.groupId, beforeTabId: overData.tabId },
      });
      return;
    }

    groups.placeTab({
      tabId: activeData.tabId,
      mode,
      target: { kind: "group", groupId: overData.groupId },
    });
  }

  function renderNode(node: EditorGroupTreeNode): ReactNode {
    if (node.kind === "group") {
      return (
        <EditorGroupPane
          group={node}
          activeGroupId={snapshot.activeGroupId}
          isDraggingTab={draggingTabId !== null}
          documents={documents}
          groups={groups}
          themeVersion={themeVersion}
          fontSize={fontSize}
          lineHeight={lineHeight}
          wordWrap={wordWrap}
          highlighting={highlighting}
          highlightingTheme={highlightingTheme}
          extraPlugins={extraPlugins}
          renderTabActions={renderTabActions}
          renderGroupOverlay={renderGroupOverlay}
          onDirtyChange={onDirtyChange}
          onSave={onSave}
        />
      );
    }

    return (
      <div
        data-wb-editor-split={node.id}
        data-axis={node.axis}
        className={cx("wb-editor-split", `wb-editor-split-${node.axis}`)}
      >
        {node.children.map((child, index) => (
          <Fragment key={child.node.id}>
            {index > 0 ? (
              <div
                role="separator"
                aria-orientation={node.axis === "horizontal" ? "vertical" : "horizontal"}
                className="wb-editor-split-divider"
              />
            ) : null}
            <div className="wb-editor-split-child" style={{ flex: `${child.size} 1 0%` }}>
              {renderNode(child.node)}
            </div>
          </Fragment>
        ))}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setDraggingTabId(null)}
    >
      <div data-wb-editor-groups="" className={cx("wb-editor-groups-root", className)}>
        {renderNode(snapshot.root)}
      </div>
    </DndContext>
  );
}
