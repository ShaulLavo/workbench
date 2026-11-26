import { useEffect, useEffectEvent, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { attachKeyboardInset, ensurePointerModalityTracking } from "@shaulavo/workbench-core";
import { useLongPressContextMenu } from "@shaulavo/workbench-core/react";
import { cx } from "../utils/cx";
import { WorkbenchPortalProvider } from "./portal";
import { ToastHost, type ToastStore } from "./toast-host";
import { TooltipLayer } from "./tooltip-layer";

export type WorkbenchThemePreset = "sprockt" | "fregat" | (string & {});
export type WorkbenchDensity = "default" | "compact";
export type WorkbenchShellMode = "desktop" | "phone";

export interface WorkbenchShellProps extends ComponentPropsWithoutRef<"div"> {
  readonly theme?: WorkbenchThemePreset;
  readonly colorScheme?: "light" | "dark";
  readonly density?: WorkbenchDensity;
  readonly shell?: WorkbenchShellMode;
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
 * modality tracking, mobile soft-keyboard inset tracking, tooltips, and toasts.
 */
export function WorkbenchShell({
  theme,
  colorScheme,
  density = "default",
  shell = "desktop",
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

  const notifyKeyboardInset = useEffectEvent((insetPx: number, open: boolean) => {
    onKeyboardInsetChange?.({ insetPx, open });
  });

  useEffect(() => {
    ensurePointerModalityTracking();
  }, []);

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
      data-wb-shell={shell}
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
