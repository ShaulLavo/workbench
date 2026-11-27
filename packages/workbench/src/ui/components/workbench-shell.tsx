import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { attachKeyboardInset, ensurePointerModalityTracking } from "../../core/index";
import { useLongPressContextMenu, useViewportMode } from "../../core/react/index";
import { useEnsureFileIconSprite } from "../../icons/sprite-manager";
import { cx } from "../utils/cx";
import { WorkbenchPortalProvider } from "./portal";
import { ToastHost, type ToastStore } from "./toast-host";
import { TooltipLayer } from "./tooltip-layer";

export type WorkbenchThemePreset = "sprockt" | "fregat" | (string & {});
export type WorkbenchDensity = "default" | "compact";
export type WorkbenchShellMode = "desktop" | "phone";

interface DocumentAttrOwnerRecord {
  readonly owner: symbol;
  readonly prior: {
    readonly wbTheme: string | null;
    readonly theme: string | null;
    readonly hadDark: boolean;
  };
}

const documentAttrOwners = new WeakMap<Document, DocumentAttrOwnerRecord>();

function captureDocumentAttributes(root: HTMLElement): DocumentAttrOwnerRecord["prior"] {
  return {
    wbTheme: root.getAttribute("data-wb-theme"),
    theme: root.getAttribute("data-theme"),
    hadDark: root.classList.contains("dark"),
  };
}

function restoreDocumentAttributes(root: HTMLElement, prior: DocumentAttrOwnerRecord["prior"]): void {
  if (prior.wbTheme === null) root.removeAttribute("data-wb-theme");
  else root.setAttribute("data-wb-theme", prior.wbTheme);

  if (prior.theme === null) root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", prior.theme);

  root.classList.toggle("dark", prior.hadDark);
}

function applyDocumentAttributes(
  root: HTMLElement,
  theme: WorkbenchThemePreset | undefined,
  colorScheme: "light" | "dark" | undefined,
): void {
  if (theme === undefined) root.removeAttribute("data-wb-theme");
  else root.setAttribute("data-wb-theme", theme);

  if (colorScheme === undefined) {
    root.removeAttribute("data-theme");
    root.classList.remove("dark");
    return;
  }
  root.setAttribute("data-theme", colorScheme);
  root.classList.toggle("dark", colorScheme === "dark");
}

function claimDocumentAttrOwner(doc: Document, owner: symbol): boolean {
  const existing = documentAttrOwners.get(doc);
  if (existing && existing.owner !== owner) {
    const nodeEnv = (globalThis as { readonly process?: { readonly env?: { readonly NODE_ENV?: string } } })
      .process?.env?.NODE_ENV;
    if (nodeEnv !== "production") {
      console.warn(
        "WorkbenchShell: another mounted WorkbenchShell already owns syncDocumentAttributes on this document; ignoring duplicate sync.",
      );
    }
    return false;
  }
  if (!existing) {
    documentAttrOwners.set(doc, {
      owner,
      prior: captureDocumentAttributes(doc.documentElement),
    });
  }
  return true;
}

function releaseDocumentAttrOwner(doc: Document, owner: symbol): void {
  const existing = documentAttrOwners.get(doc);
  if (!existing || existing.owner !== owner) return;
  restoreDocumentAttributes(doc.documentElement, existing.prior);
  documentAttrOwners.delete(doc);
}

export interface WorkbenchShellProps extends ComponentPropsWithoutRef<"div"> {
  readonly theme?: WorkbenchThemePreset;
  readonly colorScheme?: "light" | "dark";
  readonly density?: WorkbenchDensity;
  /** Layout shell mode. Defaults to `"auto"` via `useViewportMode()`. */
  readonly shell?: "auto" | WorkbenchShellMode;
  /** Mounts the shared ref-counted per-`Document` file icon sprite. Defaults to `true`. */
  readonly enableIconSprite?: boolean;
  /**
   * Mirrors `theme` and `colorScheme` onto `document.documentElement` (`data-wb-theme`, `data-theme`,
   * `.dark`) with single-owner enforcement per `Document` and automatic restoration on unmount.
   * Defaults to `false`.
   */
  readonly syncDocumentAttributes?: boolean;
  readonly titleBar?: ReactNode;
  readonly activityBar?: ReactNode;
  readonly statusBar?: ReactNode;
  readonly overlays?: ReactNode;
  readonly toastStore?: ToastStore;
  readonly enableTooltipLayer?: boolean;
  readonly enableToastHost?: boolean;
  readonly enableKeyboardInset?: boolean;
  readonly enableLongPressContextMenu?: boolean;
  readonly onKeyboardInsetChange?: (state: { readonly insetPx: number; readonly open: boolean }) => void;
}

/**
 * Root workbench frame establishing `[data-wb-theme-scope]`, scoped Base UI portals, pointer
 * modality tracking, mobile soft-keyboard inset tracking, shared ref-counted icon sprite,
 * tooltips, and toasts.
 */
export function WorkbenchShell({
  theme,
  colorScheme,
  density = "default",
  shell = "auto",
  enableIconSprite = true,
  syncDocumentAttributes = false,
  titleBar,
  activityBar,
  statusBar,
  overlays,
  toastStore,
  enableTooltipLayer = true,
  enableToastHost = true,
  enableKeyboardInset = true,
  enableLongPressContextMenu = true,
  onKeyboardInsetChange,
  className,
  children,
  ...props
}: WorkbenchShellProps) {
  const [scopeNode, setScopeNode] = useState<HTMLDivElement | null>(null);
  const detectedViewport = useViewportMode();
  const effectiveShell: WorkbenchShellMode = shell === "auto" ? detectedViewport : shell;
  const ownerSymbolRef = useRef<symbol | null>(null);
  const ownsDocAttrsRef = useRef(false);

  const notifyKeyboardInset = useEffectEvent((insetPx: number, open: boolean) => {
    onKeyboardInsetChange?.({ insetPx, open });
  });

  useEffect(() => {
    ensurePointerModalityTracking();
  }, []);

  useEnsureFileIconSprite(scopeNode?.ownerDocument ?? null, enableIconSprite);

  useEffect(() => {
    if (!syncDocumentAttributes || !scopeNode) return;
    const doc = scopeNode.ownerDocument;
    if (!ownerSymbolRef.current) {
      ownerSymbolRef.current = Symbol("wb-shell-doc-attrs");
    }
    const owner = ownerSymbolRef.current;
    const claimed = claimDocumentAttrOwner(doc, owner);
    ownsDocAttrsRef.current = claimed;
    if (!claimed) return;
    return () => {
      ownsDocAttrsRef.current = false;
      releaseDocumentAttrOwner(doc, owner);
    };
  }, [scopeNode, syncDocumentAttributes]);

  useEffect(() => {
    if (!syncDocumentAttributes || !scopeNode || !ownsDocAttrsRef.current) return;
    applyDocumentAttributes(scopeNode.ownerDocument.documentElement, theme, colorScheme);
  }, [scopeNode, syncDocumentAttributes, theme, colorScheme]);

  useEffect(() => {
    if (!enableKeyboardInset) return;
    return attachKeyboardInset({
      onChange: (insetPx, open) => notifyKeyboardInset(insetPx, open),
    });
  }, [enableKeyboardInset]);

  useLongPressContextMenu(enableLongPressContextMenu ? scopeNode : null);

  return (
    <div
      ref={setScopeNode}
      data-wb-theme-scope=""
      data-wb-theme={theme}
      data-theme={colorScheme}
      data-wb-density={density === "compact" ? "compact" : undefined}
      data-wb-shell={effectiveShell}
      className={cx("wb-shell", colorScheme === "dark" && "dark", className)}
      {...props}
    >
      <WorkbenchPortalProvider>
        {titleBar}
        <div className="wb-shell-body">
          {activityBar}
          <main className="wb-shell-workspace">{children}</main>
        </div>
        {statusBar}
        {overlays}
        {enableTooltipLayer ? <TooltipLayer /> : null}
        {enableToastHost ? <ToastHost store={toastStore} /> : null}
      </WorkbenchPortalProvider>
    </div>
  );
}
