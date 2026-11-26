import {
  useId,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type FocusEvent,
  type KeyboardEvent,
  type SyntheticEvent,
} from "react";
import { cx } from "../utils/cx";

export interface InlineRenameInputProps extends Omit<
  ComponentPropsWithoutRef<"input">,
  "value" | "defaultValue" | "onBlur" | "onKeyDown" | "onFocus" | "onChange" | "onInput"
> {
  readonly initialValue: string;
  readonly initialSelection?: readonly [start: number, end: number];
  readonly validationMessage?: string;
  readonly onValueChange?: (value: string) => void;
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
}

function stopEvent(event: SyntheticEvent): void {
  event.stopPropagation();
}

/**
 * IME-safe inline rename and file-creation input with single-settle commit/cancel guards,
 * stem-preserving initial selection, and inline validation feedback.
 */
export function InlineRenameInput({
  initialValue,
  initialSelection,
  validationMessage,
  onValueChange,
  onCommit,
  onCancel,
  className,
  autoFocus = true,
  ...props
}: InlineRenameInputProps) {
  const [value, setValue] = useState(initialValue);
  const errorId = useId();
  const settledRef = useRef(false);
  const selectedRef = useRef(false);

  function commit(input: HTMLInputElement): void {
    if (settledRef.current) return;
    if (validationMessage) {
      input.focus({ preventScroll: true });
      return;
    }
    settledRef.current = true;
    onCommit(input.value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key !== "Enter" && event.key !== "Escape") return;
    event.preventDefault();
    if (settledRef.current) return;
    if (event.key === "Enter") {
      commit(event.currentTarget);
      return;
    }
    settledRef.current = true;
    onCancel();
  }

  function handleFocus(event: FocusEvent<HTMLInputElement>): void {
    if (selectedRef.current) return;
    selectedRef.current = true;
    const [start, end] = initialSelection ?? [0, event.currentTarget.value.length];
    event.currentTarget.setSelectionRange(start, end);
  }

  return (
    <span className="wb-inline-rename-wrap" data-wb-inline-rename="">
      <input
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        {...props}
        autoFocus={autoFocus}
        aria-invalid={Boolean(validationMessage)}
        aria-describedby={validationMessage ? errorId : props["aria-describedby"]}
        className={cx("wb-inline-rename-input", className)}
        value={value}
        onBlur={(event) => commit(event.currentTarget)}
        onChange={(event) => {
          setValue(event.currentTarget.value);
          onValueChange?.(event.currentTarget.value);
        }}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        onClick={stopEvent}
        onDoubleClick={stopEvent}
        onMouseDown={stopEvent}
        onPointerDown={stopEvent}
      />
      {validationMessage ? (
        <span id={errorId} role="alert" className="wb-inline-rename-error">
          {validationMessage}
        </span>
      ) : null}
    </span>
  );
}
