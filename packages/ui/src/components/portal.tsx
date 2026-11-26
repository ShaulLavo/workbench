import { createContext, useContext, useState, type ReactNode } from "react";

const WorkbenchPortalContext = createContext<HTMLElement | null>(null);

export interface WorkbenchPortalProviderProps {
  /** Optional external container override; defaults to a scoped `[data-wb-portal-root]` node. */
  readonly container?: HTMLElement | null;
  readonly children: ReactNode;
}

/**
 * Mounts a scoped `[data-wb-portal-root]` container inside the active theme and density root so
 * every Base UI popup (`Dialog`, `AlertDialog`, `Menu`, `ContextMenu`, `Tooltip`) inherits
 * `--wb-*` tokens, `data-theme`, `data-wb-density`, and `data-wb-shell`.
 */
export function WorkbenchPortalProvider({ container, children }: WorkbenchPortalProviderProps) {
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);
  const resolved = container ?? portalRoot;

  return (
    <WorkbenchPortalContext value={resolved}>
      {children}
      {container ? null : <div ref={setPortalRoot} data-wb-portal-root="" />}
    </WorkbenchPortalContext>
  );
}

/** Returns the active workbench portal container (`HTMLElement | null`), or `undefined` to fall back to `document.body`. */
export function useWorkbenchPortalContainer(override?: HTMLElement | null): HTMLElement | undefined {
  const fromContext = useContext(WorkbenchPortalContext);
  const target = override ?? fromContext;
  return target ?? undefined;
}
