import type { ComponentPropsWithoutRef } from "react";
import { cx } from "../utils/cx";

export interface KbdProps extends ComponentPropsWithoutRef<"kbd"> {
  readonly size?: "sm" | "md";
}

/** Styled keyboard shortcut chip that adapts to the surrounding foreground color. */
export function Kbd({ size = "sm", className, ...props }: KbdProps) {
  return (
    <kbd
      data-wb-kbd=""
      data-size={size}
      className={cx("wb-kbd", size === "md" ? "wb-kbd-md" : "wb-kbd-sm", className)}
      {...props}
    />
  );
}
