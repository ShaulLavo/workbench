import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
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

const DRAG_THRESHOLD_PX = 5;

export interface EditorTabBarProps {
  readonly groupId: GroupId;
  readonly tabs: readonly EditorTabDescriptor[];
  readonly selectedTabId: TabId | null;
  readonly label?: string;
  readonly iconPreset?: FileIconPreset;
  readonly actions?: ReactNode;
  readonly stripRef?: RefObject<HTMLDivElement | null>;
  readonly getTabTone?: (tab: EditorTabDescriptor) => string | undefined;
  readonly renderIcon?: (tab: EditorTabDescriptor) => ReactNode;
  readonly tabTestId?: (tab: EditorTabDescriptor) => string;
  readonly dirtyTestId?: (tab: EditorTabDescriptor, active: boolean) => string | undefined;
  readonly onSelectTab: (groupId: GroupId, tabId: TabId, focus: ActivationFocusDecision) => void;
  readonly onCloseTab: (groupId: GroupId, tabId: TabId) => void;
  readonly onPinTab?: (groupId: GroupId, tabId: TabId) => void;
  readonly onReorderTab?: (groupId: GroupId, fromIndex: number, toIndex: number) => void;
  readonly onTabContextMenu?: (tab: EditorTabDescriptor, event: MouseEvent<HTMLDivElement>) => void;
  readonly className?: string;
  readonly testId?: string;
}

interface TabDragState {
  index: number;
  readonly startX: number;
  readonly pointerId: number;
  moved: boolean;
}

function parentDirectory(path: string): string {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return "/";
  return path.slice(0, slash);
}

function computeAutoHints(tabs: readonly EditorTabDescriptor[]): Map<TabId, string> {
  const labelCounts = new Map<string, number>();
  for (const tab of tabs) {
    labelCounts.set(tab.label, (labelCounts.get(tab.label) ?? 0) + 1);
  }
  const hints = new Map<TabId, string>();
  for (const tab of tabs) {
    if (tab.hint !== undefined) {
      if (tab.hint) hints.set(tab.id, tab.hint);
      continue;
    }
    if ((labelCounts.get(tab.label) ?? 0) > 1 && tab.path) {
      hints.set(tab.id, parentDirectory(tab.path));
    }
  }
  return hints;
}

function revealElementInStrip(strip: HTMLDivElement, tab: HTMLElement): void {
  if (strip.scrollWidth <= strip.clientWidth) return;
  const padding = Number.parseFloat(getComputedStyle(strip).scrollPaddingLeft) || 0;
  const stripRect = strip.getBoundingClientRect();
  const tabRect = tab.getBoundingClientRect();
  const leftGap = tabRect.left - (stripRect.left + padding);
  if (leftGap < 0) {
    strip.scrollLeft += leftGap;
    return;
  }
  const rightGap = tabRect.right - (stripRect.right - padding);
  if (rightGap > 0) {
    strip.scrollLeft += rightGap;
  }
}

function findDragSlot(strip: HTMLDivElement | null, clientX: number, fromIndex: number): number {
  const items = Array.from(strip?.querySelectorAll<HTMLElement>("[data-wb-tab]") ?? []);
  let slot = 0;
  for (let index = 0; index < items.length; index += 1) {
    if (index === fromIndex) continue;
    const item = items[index];
    if (!item) continue;
    const rect = item.getBoundingClientRect();
    if (rect.left + rect.width / 2 < clientX) slot += 1;
  }
  return slot;
}

function resolveTabFocusDecision(
  decision: ActivationFocusDecision | undefined,
  event: MouseEvent<HTMLButtonElement>,
  recordedPointerType: string | undefined,
): ActivationFocusDecision {
  if (recordedPointerType === "touch") {
    return { shouldFocusEditor: false, origin: "touch" };
  }
  if (recordedPointerType === "pen") {
    return { shouldFocusEditor: true, origin: "pen" };
  }
  return decision ?? resolveActivationFocus(event, "auto");
}

function nextTabIndexForKey(key: string, index: number, count: number): number | null {
  if (count <= 1) return null;
  if (key === "ArrowRight") return (index + 1) % count;
  if (key === "ArrowLeft") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}

/**
 * Editor tab strip enforcing per-activation touch focus policy: tapping a file tab on touch/coarse
 * viewports never focuses Singapore's editor input and dismisses any open soft keyboard. Supports
 * duplicate-name directory hints, active tab auto-reveal, non-touch pointer drag reorder, and
 * keyboard tab navigation.
 */
export function EditorTabBar({
  groupId,
  tabs,
  selectedTabId,
  label = "Open editors",
  iconPreset = "rich",
  actions,
  stripRef,
  getTabTone,
  renderIcon,
  tabTestId,
  dirtyTestId,
  onSelectTab,
  onCloseTab,
  onPinTab,
  onReorderTab,
  onTabContextMenu,
  className,
  testId,
}: EditorTabBarProps) {
  const internalStripRef = useRef<HTMLDivElement | null>(null);
  const resolvedStripRef = stripRef ?? internalStripRef;
  const lastPointerTypeRef = useRef<string | undefined>(undefined);
  const tabNodesRef = useRef<Map<TabId, HTMLDivElement>>(new Map());
  const dragRef = useRef<TabDragState | null>(null);
  const suppressClickRef = useRef(false);
  const reorderCallbackRef = useRef(onReorderTab);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);

  useEffect(() => {
    reorderCallbackRef.current = onReorderTab;
  }, [onReorderTab]);

  useEffect(() => {
    if (!selectedTabId) return;
    const strip = resolvedStripRef.current;
    const node = tabNodesRef.current.get(selectedTabId);
    if (!strip || !node) return;
    revealElementInStrip(strip, node);
  }, [resolvedStripRef, selectedTabId, tabs]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent): void {
      const state = dragRef.current;
      if (!state || event.pointerId !== state.pointerId) return;
      if (!state.moved && Math.abs(event.clientX - state.startX) < DRAG_THRESHOLD_PX) return;
      state.moved = true;
      const slot = findDragSlot(resolvedStripRef.current, event.clientX, state.index);
      setDraggingIndex(slot);
      if (slot === state.index) return;
      reorderCallbackRef.current?.(groupId, state.index, slot);
      state.index = slot;
    }

    function handlePointerEnd(event: PointerEvent): void {
      const state = dragRef.current;
      if (!state || event.pointerId !== state.pointerId) return;
      suppressClickRef.current = event.type !== "pointercancel" && state.moved;
      dragRef.current = null;
      setDraggingIndex(null);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [groupId, resolvedStripRef]);

  function startPointerDrag(event: ReactPointerEvent<HTMLDivElement>, index: number): void {
    lastPointerTypeRef.current = event.pointerType;
    suppressClickRef.current = false;
    if (!onReorderTab || event.button !== 0 || event.pointerType === "touch") return;
    dragRef.current = {
      index,
      startX: event.clientX,
      pointerId: event.pointerId,
      moved: false,
    };
  }

  function handleActivate(
    tab: EditorTabDescriptor,
    decision: ActivationFocusDecision,
    event: MouseEvent<HTMLButtonElement>,
  ): void {
    const recordedPointer = lastPointerTypeRef.current;
    lastPointerTypeRef.current = undefined;
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const resolved = resolveTabFocusDecision(decision, event, recordedPointer);
    if (!resolved.shouldFocusEditor) {
      dismissSoftKeyboardOnTouchActivation(resolved, event.currentTarget);
    }
    onSelectTab(groupId, tab.id, resolved);
  }

  function handleTabKeyDown(
    tab: EditorTabDescriptor,
    index: number,
    event: KeyboardEvent<HTMLButtonElement>,
  ): void {
    if (event.key === "Delete") {
      event.preventDefault();
      onCloseTab(groupId, tab.id);
      return;
    }
    const nextIndex = nextTabIndexForKey(event.key, index, tabs.length);
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    const node = tabNodesRef.current.get(nextTab.id);
    node?.querySelector<HTMLButtonElement>('[role="tab"]')?.focus();
  }

  const hints = computeAutoHints(tabs);

  return (
    <BarTabStrip
      label={label}
      actions={actions}
      stripRef={resolvedStripRef}
      onStripScroll={() => {
        lastPointerTypeRef.current = undefined;
      }}
      className={className}
      data-testid={testId}
    >
      {tabs.map((tab, index) => {
        const active = tab.id === selectedTabId;
        const tone = tab.tone ?? getTabTone?.(tab);
        const icon = renderIcon ? (
          renderIcon(tab)
        ) : (
          <FileTypeIcon entry={{ name: tab.path ?? tab.label, type: "file" }} preset={iconPreset} />
        );
        return (
          <BarTab
            key={tab.id}
            tabRef={(node) => {
              if (node) tabNodesRef.current.set(tab.id, node);
              else tabNodesRef.current.delete(tab.id);
            }}
            active={active}
            label={tab.label}
            hint={hints.get(tab.id)}
            title={tab.title}
            tone={tone}
            preview={tab.preview}
            dirty={tab.dirty}
            missing={tab.missing}
            dragging={draggingIndex === index}
            dirtyTestId={dirtyTestId?.(tab, active)}
            data-testid={tabTestId ? tabTestId(tab) : `wb-editor-tab-${tab.id}`}
            data-path={tab.path}
            data-tab-kind={tab.kind}
            icon={icon}
            onPointerDown={(event) => startPointerDrag(event, index)}
            onPointerCancel={() => {
              lastPointerTypeRef.current = undefined;
            }}
            onActivate={(focus, event) => handleActivate(tab, focus, event)}
            onDoubleClickLabel={tab.preview && onPinTab ? () => onPinTab(groupId, tab.id) : undefined}
            onTabKeyDown={(event) => handleTabKeyDown(tab, index, event)}
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
