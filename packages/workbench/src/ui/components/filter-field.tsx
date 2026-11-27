import {
  useImperativeHandle,
  useRef,
  type ComponentPropsWithoutRef,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { StrokeIcon } from "../../icons/react";
import { cx } from "../utils/cx";

export interface FilterFieldHandle {
  readonly focus: () => void;
  readonly seed: (character: string) => void;
}

export interface FilterFieldProps extends Omit<
  ComponentPropsWithoutRef<"input">,
  "value" | "defaultValue" | "onChange" | "onInput" | "onBlur" | "ref"
> {
  readonly ref?: Ref<FilterFieldHandle>;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly onArrowDown?: () => void;
  readonly blurBehavior?: "retain" | "clear";
  readonly clearLabel?: string;
  readonly trailing?: ReactNode;
}

/**
 * Composite search/filter field with leading search glyph, IME-safe Escape clear/blur, ArrowDown
 * list handoff, optional trailing toggles, and coarse-pointer 16px zoom prevention.
 */
export function FilterField({
  ref,
  value,
  onValueChange,
  onArrowDown,
  blurBehavior = "retain",
  clearLabel = "Clear filter",
  trailing,
  className,
  onKeyDown,
  ...inputProps
}: FilterFieldProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      focus() {
        inputRef.current?.focus();
      },
      seed(character: string) {
        onValueChange(character);
        inputRef.current?.focus();
      },
    }),
    [onValueChange],
  );

  function handleBlur(event: FocusEvent<HTMLDivElement>): void {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    if (blurBehavior === "clear") onValueChange("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (value) onValueChange("");
      else event.currentTarget.blur();
      return;
    }
    if (event.key === "ArrowDown" && onArrowDown) {
      event.preventDefault();
      event.stopPropagation();
      onArrowDown();
      return;
    }
    onKeyDown?.(event);
  }

  return (
    <div data-wb-filter-field="" className={cx("wb-filter-field", className)} onBlur={handleBlur}>
      <StrokeIcon name="search" className="wb-filter-icon" />
      <input
        {...inputProps}
        ref={inputRef}
        type="text"
        className="wb-filter-input"
        value={value}
        onChange={(event) => onValueChange(event.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      {trailing ? <div className="wb-filter-trailing">{trailing}</div> : null}
      {value ? (
        <button
          type="button"
          className="wb-filter-clear"
          aria-label={clearLabel}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
          onClick={() => {
            onValueChange("");
            inputRef.current?.focus();
          }}
        >
          <StrokeIcon name="close" />
        </button>
      ) : null}
    </div>
  );
}
