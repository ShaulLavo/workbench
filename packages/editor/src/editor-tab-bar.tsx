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
  readonly tabId: TabId;
  readonly groupId: GroupId;
  readonly startX: number;
  readonly pointerId: number;
  moved: boolean;
  lastEmittedSlot: number | null;
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

function findDragSlotByTabId(strip: HTMLDivElement | null, clientX: number, draggedTabId: TabId): number {
  const items = Array.from(strip?.querySelectorAll<HTMLElement>("[data-wb-tab]") ?? []);
  let slot = 0;
  for (const item of items) {
    if (item.dataset.tabId === draggedTabId) continue;
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
  const tabsRef = useRef<readonly EditorTabDescriptor[]>(tabs);
  const groupIdRef = useRef<GroupId>(groupId);
  const dragRef = useRef<TabDragState | null>(null);
  const suppressClickRef = useRef(false);
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reorderCallbackRef = useRef(onReorderTab);
  const [draggingTabId, setDraggingTabId] = useState<TabId | null>(null);

  useEffect(() => {
    tabsRef.current = tabs;
    groupIdRef.current = groupId;
    reorderCallbackRef.current = onReorderTab;
    const activeDrag = dragRef.current;
    if (!activeDrag) return;
    const stillPresent = activeDrag.groupId === groupId && tabs.some((tab) => tab.id === activeDrag.tabId);
    if (stillPresent) {
      activeDrag.lastEmittedSlot = null;
      return;
    }
    dragRef.current = null;
    queueMicrotask(() => setDraggingTabId(null));
  }, [groupId, onReorderTab, tabs]);

  useEffect(() => {
    if (!selectedTabId) return;
    const strip = resolvedStripRef.current;
    const node = tabNodesRef.current.get(selectedTabId);
    if (!strip || !node) return;
    revealElementInStrip(strip, node);
  }, [resolvedStripRef, selectedTabId, tabs]);

  useEffect(() => {
    function cancelDrag(): void {
      dragRef.current = null;
      setDraggingTabId(null);
    }

    function handlePointerMove(event: PointerEvent): void {
      const state = dragRef.current;
      if (!state || event.pointerId !== state.pointerId) return;
      if (state.groupId !== groupIdRef.current) return cancelDrag();
      const currentIndex = tabsRef.current.findIndex((tab) => tab.id === state.tabId);
      if (currentIndex < 0) return cancelDrag();
      if (!state.moved && Math.abs(event.clientX - state.startX) < DRAG_THRESHOLD_PX) return;
      state.moved = true;
      setDraggingTabId(state.tabId);
      const slot = findDragSlotByTabId(resolvedStripRef.current, event.clientX, state.tabId);
      if (slot === currentIndex || slot === state.lastEmittedSlot) return;
      state.lastEmittedSlot = slot;
      reorderCallbackRef.current?.(state.groupId, currentIndex, slot);
    }

    function handlePointerEnd(event: PointerEvent): void {
      const state = dragRef.current;
      if (!state || event.pointerId !== state.pointerId) return;
      const shouldSuppress = event.type !== "pointercancel" && state.moved;
      cancelDrag();
      clearTimeout(suppressTimerRef.current);
      suppressClickRef.current = shouldSuppress;
      if (!shouldSuppress) return;
      // Only suppress the synthetic click that immediately follows pointerup on the dragged tab.
      suppressTimerRef.current = setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      clearTimeout(suppressTimerRef.current);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
    };
  }, [resolvedStripRef]);

  function startPointerDrag(event: ReactPointerEvent<HTMLDivElement>, tabId: TabId): void {
    lastPointerTypeRef.current = event.pointerType;
    clearTimeout(suppressTimerRef.current);
    suppressClickRef.current = false;
    if (!onReorderTab || event.button !== 0 || event.pointerType === "touch") return;
    dragRef.current = {
      tabId,
      groupId,
      startX: event.clientX,
      pointerId: event.pointerId,
      moved: false,
      lastEmittedSlot: null,
    };
  }

  function handleActivate(
    tab: EditorTabDescriptor,
    decision: ActivationFocusDecision,
    event: MouseEvent<HTMLButtonElement>,
  ): void {
    const recordedPointer = lastPointerTypeRef.current;
    lastPointerTypeRef.current = undefined;
    const isKeyboardClick = event.detail === 0;
    if (!isKeyboardClick && suppressClickRef.current) {
      clearTimeout(suppressTimerRef.current);
      suppressClickRef.current = false;
      return;
    }
    const resolved = resolveTabFocusDecision(decision, event, recordedPointer);
    if (!resolved.shouldFocusEditor) {
      dismissSoftKeyboardOnTouchActivation(resolved, event.currentTarget);
    }
    onSelectTab(groupId, tab.id, resolved);
  }

  function handleTabMouseDown(event: MouseEvent<HTMLDivElement>, tabId: TabId): void {
    if (event.button !== 1) return;
    event.preventDefault();
    onCloseTab(groupId, tabId);
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
            dragging={draggingTabId === tab.id}
            dirtyTestId={dirtyTestId?.(tab, active)}
            data-testid={tabTestId ? tabTestId(tab) : `wb-editor-tab-${tab.id}`}
            data-tab-id={tab.id}
            data-path={tab.path}
            data-tab-kind={tab.kind}
            icon={icon}
            onPointerDown={(event) => startPointerDrag(event, tab.id)}
            onPointerCancel={() => {
              lastPointerTypeRef.current = undefined;
            }}
            onActivate={(focus, event) => handleActivate(tab, focus, event)}
            onDoubleClickLabel={tab.preview && onPinTab ? () => onPinTab(groupId, tab.id) : undefined}
            onTabKeyDown={(event) => handleTabKeyDown(tab, index, event)}
            onClose={() => onCloseTab(groupId, tab.id)}
            onMouseDown={(event) => handleTabMouseDown(event, tab.id)}
            onContextMenu={onTabContextMenu ? (event) => onTabContextMenu(tab, event) : undefined}
          />
        );
      })}
    </BarTabStrip>
  );
}
