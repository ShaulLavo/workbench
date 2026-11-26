import { useRef } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { cx } from "../utils/cx";
import { useWorkbenchPortalContainer } from "./portal";

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
  readonly busy?: boolean;
  readonly error?: string;
  readonly portalContainer?: HTMLElement | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * Confirmation modal built on Base UI `AlertDialog` and portaled into the workbench theme scope.
 * Focuses the cancel action first so pressing Enter cannot trigger destructive actions by accident.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  busy = false,
  error,
  portalContainer,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const container = useWorkbenchPortalContainer(portalContainer);

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && !busy) onCancel();
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={handleOpenChange}>
      <AlertDialog.Portal container={container}>
        <AlertDialog.Backdrop className="wb-dialog-backdrop" />
        <AlertDialog.Popup
          className="wb-dialog-popup"
          initialFocus={cancelRef}
          data-testid="wb-confirm-dialog"
        >
          <AlertDialog.Title className="wb-dialog-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="wb-dialog-description">{description}</AlertDialog.Description>
          {error ? (
            <p className="wb-dialog-error" role="alert" data-testid="wb-confirm-error">
              {error}
            </p>
          ) : null}
          <div className="wb-dialog-actions">
            <button
              ref={cancelRef}
              type="button"
              className="wb-button"
              data-testid="wb-confirm-cancel"
              disabled={busy}
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              className={cx("wb-button", danger ? "wb-button-danger" : "wb-button-primary")}
              data-testid="wb-confirm-accept"
              disabled={busy}
              onClick={onConfirm}
            >
              {confirmLabel}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
