import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cx } from "../utils/cx";

export interface TitleBarProps extends ComponentPropsWithoutRef<"header"> {
  readonly leading?: ReactNode;
  readonly center?: ReactNode;
  readonly trailing?: ReactNode;
}

/** Top chrome bar sized to `--wb-bar-height` with leading, center, and trailing slots. */
export function TitleBar({ leading, center, trailing, className, children, ...props }: TitleBarProps) {
  return (
    <header data-wb-title-bar="" className={cx("wb-title-bar", className)} {...props}>
      {children ?? (
        <>
          <div className="wb-title-bar-slot wb-title-bar-leading">{leading}</div>
          <div className="wb-title-bar-slot wb-title-bar-center">{center}</div>
          <div className="wb-title-bar-slot wb-title-bar-trailing">{trailing}</div>
        </>
      )}
    </header>
  );
}
