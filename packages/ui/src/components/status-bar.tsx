import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "../utils/cx";

export interface StatusBarProps extends ComponentPropsWithoutRef<"footer"> {
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
}

/** Compact bottom status strip with tabular monospace metadata slots. */
export function StatusBar({ leading, trailing, className, children, ...props }: StatusBarProps) {
  return (
    <footer data-wb-status-bar="" className={cx("wb-status-bar", className)} {...props}>
      {children ?? (
        <>
          <div className="wb-status-bar-group">{leading}</div>
          <div className="wb-status-bar-group wb-status-bar-trailing">{trailing}</div>
        </>
      )}
    </footer>
  );
}
