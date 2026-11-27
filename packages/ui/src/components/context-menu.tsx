import { Fragment, type ReactNode } from "react";
import { ContextMenu as BaseContextMenu } from "@base-ui/react/context-menu";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { cx } from "../utils/cx";
import { Kbd } from "./kbd";
import { useWorkbenchPortalContainer } from "./portal";

export interface ContextMenuItem {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly icon?: ReactNode;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly separatorBefore?: boolean;
  readonly testId?: string;
  readonly onSelect: () => void;
}

export interface ContextMenuProps {
  readonly items: readonly ContextMenuItem[];
  readonly label?: string;
  readonly portalContainer?: HTMLElement | null;
  readonly children: ReactNode;
  readonly className?: string;
}

/** Declarative right-click context menu built on Base UI and portaled inside the workbench theme scope. */
export function ContextMenu({
  items,
  label = "Context menu",
  portalContainer,
  children,
  className,
}: ContextMenuProps) {
  const container = useWorkbenchPortalContainer(portalContainer);

  return (
    <BaseContextMenu.Root>
      <BaseContextMenu.Trigger data-wb-native-long-press="true" className={className}>
        {children}
      </BaseContextMenu.Trigger>
      <BaseContextMenu.Portal container={container}>
        <BaseContextMenu.Positioner className="wb-menu-positioner" sideOffset={2}>
          <BaseContextMenu.Popup className="wb-menu-popup" aria-label={label} data-wb-context-menu="">
            {items.map((item) => (
              <Fragment key={item.id}>
                {item.separatorBefore ? <BaseContextMenu.Separator className="wb-menu-separator" /> : null}
                <BaseContextMenu.Item
                  className={cx("wb-menu-item", item.danger && "wb-menu-item-danger")}
                  disabled={item.disabled}
                  data-testid={item.testId}
                  onClick={item.onSelect}
                >
                  {item.icon ? (
                    <span className="wb-menu-item-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                  ) : null}
                  <span className="wb-menu-item-label">{item.label}</span>
                  {item.hint ? <Kbd>{item.hint}</Kbd> : null}
                </BaseContextMenu.Item>
              </Fragment>
            ))}
          </BaseContextMenu.Popup>
        </BaseContextMenu.Positioner>
      </BaseContextMenu.Portal>
    </BaseContextMenu.Root>
  );
}

export interface PointContextMenuProps {
  readonly open: boolean;
  readonly x: number;
  readonly y: number;
  readonly items: readonly ContextMenuItem[];
  readonly label?: string;
  readonly portalContainer?: HTMLElement | null;
  readonly onOpenChange: (open: boolean, reason?: string) => void;
}

function createPointRect(x: number, y: number): DOMRect {
  if (typeof DOMRect !== "undefined" && typeof DOMRect.fromRect === "function") {
    return DOMRect.fromRect({ x, y, width: 0, height: 0 });
  }
  return {
    x,
    y,
    width: 0,
    height: 0,
    top: y,
    left: x,
    right: x,
    bottom: y,
    toJSON() {
      return { x, y, width: 0, height: 0, top: y, left: x, right: x, bottom: y };
    },
  };
}

/**
 * Controlled coordinate-anchored context menu for programmatic and synthesized long-press triggers,
 * backed by Base UI `Menu` and portaled into the active workbench theme scope.
 */
export function PointContextMenu({
  open,
  x,
  y,
  items,
  label = "Context menu",
  portalContainer,
  onOpenChange,
}: PointContextMenuProps) {
  const container = useWorkbenchPortalContainer(portalContainer);
  const anchor = {
    getBoundingClientRect: () => createPointRect(x, y),
  };

  return (
    <BaseMenu.Root open={open} onOpenChange={(nextOpen, details) => onOpenChange(nextOpen, details.reason)}>
      <BaseMenu.Portal container={container}>
        <BaseMenu.Positioner
          anchor={anchor}
          side="bottom"
          align="start"
          sideOffset={2}
          collisionPadding={6}
          className="wb-menu-positioner"
        >
          <BaseMenu.Popup className="wb-menu-popup" aria-label={label} data-wb-point-context-menu="">
            {items.map((item) => (
              <Fragment key={item.id}>
                {item.separatorBefore ? <BaseMenu.Separator className="wb-menu-separator" /> : null}
                <BaseMenu.Item
                  className={cx("wb-menu-item", item.danger && "wb-menu-item-danger")}
                  disabled={item.disabled}
                  data-testid={item.testId}
                  onClick={item.onSelect}
                >
                  {item.icon ? (
                    <span className="wb-menu-item-icon" aria-hidden="true">
                      {item.icon}
                    </span>
                  ) : null}
                  <span className="wb-menu-item-label">{item.label}</span>
                  {item.hint ? <Kbd>{item.hint}</Kbd> : null}
                </BaseMenu.Item>
              </Fragment>
            ))}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}
