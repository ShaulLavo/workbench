import type {
  EditorGroupNode,
  EditorGroupsSnapshot,
  EditorGroupTreeNode,
  EditorSplitChild,
  EditorSplitNode,
  EditorTabDescriptor,
  GroupId,
  TabId,
  TabPlacement,
} from "@shaulavo/workbench-core";

export type GroupDropEdge = "left" | "right" | "top" | "bottom" | "center";

/** Finds a group node by id within a recursive split tree. */
export function findGroupNode(node: EditorGroupTreeNode, id: GroupId): EditorGroupNode | null {
  if (node.kind === "group") return node.id === id ? node : null;
  for (const child of node.children) {
    const found = findGroupNode(child.node, id);
    if (found) return found;
  }
  return null;
}

/** Lists all leaf group nodes in left-to-right / top-to-bottom order. */
export function listGroupNodes(node: EditorGroupTreeNode): readonly EditorGroupNode[] {
  if (node.kind === "group") return [node];
  const out: EditorGroupNode[] = [];
  for (const child of node.children) {
    for (const leaf of listGroupNodes(child.node)) {
      out.push(leaf);
    }
  }
  return out;
}

/** Classifies a pointer coordinate inside a group rect into center or an edge split zone. */
export function computeEdgeDropZone(
  point: { readonly x: number; readonly y: number },
  rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  edgeRatio = 0.24,
): GroupDropEdge {
  if (rect.width <= 0 || rect.height <= 0) return "center";
  const relX = (point.x - rect.left) / rect.width;
  const relY = (point.y - rect.top) / rect.height;
  if (relX < edgeRatio) return "left";
  if (relX > 1 - edgeRatio) return "right";
  if (relY < edgeRatio) return "top";
  if (relY > 1 - edgeRatio) return "bottom";
  return "center";
}

function findTabWithGroup(
  node: EditorGroupTreeNode,
  tabId: TabId,
): { readonly groupId: GroupId; readonly tab: EditorTabDescriptor } | null {
  if (node.kind === "group") {
    const tab = node.tabs.find((item) => item.id === tabId);
    return tab ? { groupId: node.id, tab } : null;
  }
  for (const child of node.children) {
    const found = findTabWithGroup(child.node, tabId);
    if (found) return found;
  }
  return null;
}

function toSplitChildren(children: readonly EditorSplitChild[]): EditorSplitNode["children"] {
  const [first, second, ...rest] = children;
  if (!first || !second) {
    throw new Error("EditorSplitNode requires at least two children");
  }
  return [first, second, ...rest];
}

function removeTabFromGroup(node: EditorGroupTreeNode, groupId: GroupId, tabId: TabId): EditorGroupTreeNode {
  if (node.kind === "group") {
    if (node.id !== groupId) return node;
    const nextTabs = node.tabs.filter((item) => item.id !== tabId);
    const nextSelected = node.selectedTabId === tabId ? (nextTabs[0]?.id ?? null) : node.selectedTabId;
    return { ...node, tabs: nextTabs, selectedTabId: nextSelected };
  }
  const nextChildren = node.children.map((child) => ({
    ...child,
    node: removeTabFromGroup(child.node, groupId, tabId),
  }));
  return {
    ...node,
    children: toSplitChildren(nextChildren),
  };
}

function pruneEmptyGroups(node: EditorGroupTreeNode): EditorGroupTreeNode | null {
  if (node.kind === "group") {
    return node.tabs.length > 0 ? node : null;
  }
  const kept: EditorSplitChild[] = [];
  for (const child of node.children) {
    const pruned = pruneEmptyGroups(child.node);
    if (pruned) kept.push({ ...child, node: pruned });
  }
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!.node;
  const total = kept.reduce((sum, item) => sum + item.size, 0) || 100;
  const normalized = kept.map((item) => ({
    node: item.node,
    size: Math.round((item.size / total) * 1000) / 10,
  }));
  return {
    ...node,
    children: toSplitChildren(normalized),
  };
}

function insertTabIntoGroup(
  node: EditorGroupTreeNode,
  groupId: GroupId,
  tab: EditorTabDescriptor,
  beforeTabId: TabId | null,
): EditorGroupTreeNode {
  if (node.kind === "group") {
    if (node.id !== groupId) return node;
    const deduped = node.tabs.filter((item) => item.id !== tab.id);
    const idx = beforeTabId ? deduped.findIndex((item) => item.id === beforeTabId) : -1;
    const nextTabs =
      idx >= 0 ? deduped.slice(0, idx).concat([tab], deduped.slice(idx)) : deduped.concat([tab]);
    return { ...node, tabs: nextTabs, selectedTabId: tab.id };
  }
  const nextChildren = node.children.map((child) => ({
    ...child,
    node: insertTabIntoGroup(child.node, groupId, tab, beforeTabId),
  }));
  return {
    ...node,
    children: toSplitChildren(nextChildren),
  };
}

function splitGroupWithTab(
  node: EditorGroupTreeNode,
  targetGroupId: GroupId,
  edge: "left" | "right" | "top" | "bottom",
  newGroup: EditorGroupNode,
  splitId: string,
): EditorGroupTreeNode {
  if (node.kind === "group") {
    if (node.id !== targetGroupId) return node;
    const axis = edge === "left" || edge === "right" ? "horizontal" : "vertical";
    const before = edge === "left" || edge === "top";
    const first: EditorSplitChild = { node: before ? newGroup : node, size: 50 };
    const second: EditorSplitChild = { node: before ? node : newGroup, size: 50 };
    return {
      kind: "split",
      id: splitId,
      axis,
      children: [first, second],
    };
  }
  const nextChildren = node.children.map((child) => ({
    ...child,
    node: splitGroupWithTab(child.node, targetGroupId, edge, newGroup, splitId),
  }));
  return {
    ...node,
    children: toSplitChildren(nextChildren),
  };
}

let generatedGroupSeq = 0;

/**
 * Pure immutable `TabPlacement` reducer supporting intra-group reorder, cross-group move/copy,
 * edge splitting, and automatic empty-group collapse.
 */
export function applyTabPlacement(
  snapshot: EditorGroupsSnapshot,
  placement: TabPlacement,
  options?: {
    readonly createGroupId?: () => GroupId;
    readonly createSplitId?: () => string;
    readonly createCopyTabId?: (sourceTab: EditorTabDescriptor) => TabId;
  },
): EditorGroupsSnapshot {
  const source = findTabWithGroup(snapshot.root, placement.tabId);
  if (!source) return snapshot;

  const isCopy = placement.mode === "copy";
  const tabToPlace: EditorTabDescriptor = isCopy
    ? {
        ...source.tab,
        id: options?.createCopyTabId?.(source.tab) ?? `${source.tab.id}-copy-${(generatedGroupSeq += 1)}`,
      }
    : source.tab;

  const { target } = placement;

  if (target.kind === "edge") {
    const newGroupId = options?.createGroupId?.() ?? `group-${(generatedGroupSeq += 1)}`;
    const splitId = options?.createSplitId?.() ?? `split-${(generatedGroupSeq += 1)}`;
    const newGroup: EditorGroupNode = {
      kind: "group",
      id: newGroupId,
      tabs: [tabToPlace],
      selectedTabId: tabToPlace.id,
    };
    const baseRoot = isCopy
      ? snapshot.root
      : removeTabFromGroup(snapshot.root, source.groupId, source.tab.id);
    const splitRoot = splitGroupWithTab(baseRoot, target.groupId, target.edge, newGroup, splitId);
    const pruned = pruneEmptyGroups(splitRoot) ?? newGroup;
    return { root: pruned, activeGroupId: newGroupId };
  }

  const beforeTabId = target.kind === "strip" ? target.beforeTabId : null;
  if (isCopy && source.groupId === target.groupId) {
    const nextRoot = insertTabIntoGroup(snapshot.root, target.groupId, tabToPlace, beforeTabId);
    return { root: nextRoot, activeGroupId: target.groupId };
  }

  const withoutSource = isCopy
    ? snapshot.root
    : removeTabFromGroup(snapshot.root, source.groupId, source.tab.id);
  const inserted = insertTabIntoGroup(withoutSource, target.groupId, tabToPlace, beforeTabId);
  const pruned = pruneEmptyGroups(inserted) ?? inserted;
  return { root: pruned, activeGroupId: target.groupId };
}
