import { useRef } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useWorkbenchPortalContainer } from "./portal";

export interface UnsavedChangesDialogProps {
  readonly open: boolean;
  readonly files: readonly string[];
  readonly saving?: boolean;
  readonly error?: string;
  readonly saveLabel?: string;
  readonly discardLabel?: string;
  readonly cancelLabel?: string;
  readonly portalContainer?: HTMLElement | null;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onCancel: () => void;
}

/** Three-way unsaved changes prompt (Cancel, Discard, Save) portaled inside the workbench theme scope. */
export function UnsavedChangesDialog({
  open,
  files,
  saving = false,
  error,
  saveLabel = "Save and close",
  discardLabel = "Don't save",
  cancelLabel = "Cancel",
  portalContainer,
  onSave,
  onDiscard,
  onCancel,
}: UnsavedChangesDialogProps) {
  const saveRef = useRef<HTMLButtonElement | null>(null);
  const container = useWorkbenchPortalContainer(portalContainer);

  const singleFile = files.length === 1 ? files[0] : undefined;
  const title = singleFile ? `Save changes to ${singleFile}?` : `Save changes to ${files.length} files?`;
  const description = singleFile
    ? "Your unsaved edits will be lost if you close without saving."
    : "Your unsaved edits across these files will be lost if you close without saving.";

  function handleOpenChange(nextOpen: boolean): void {
    if (!nextOpen && !saving) onCancel();
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={handleOpenChange}>
      <AlertDialog.Portal container={container}>
        <AlertDialog.Backdrop className="wb-dialog-backdrop" />
        <AlertDialog.Popup className="wb-dialog-popup" initialFocus={saveRef} data-testid="wb-unsaved-dialog">
          <AlertDialog.Title className="wb-dialog-title">{title}</AlertDialog.Title>
          <AlertDialog.Description className="wb-dialog-description">{description}</AlertDialog.Description>
          {error ? (
            <p className="wb-dialog-error" role="alert" data-testid="wb-unsaved-error">
              {error}
            </p>
          ) : null}
          <div className="wb-dialog-actions">
            <button
              type="button"
              className="wb-button"
              data-testid="wb-unsaved-cancel"
              disabled={saving}
              onClick={onCancel}
            >
              {cancelLabel}
            </button>
            <button
              type="button"
              className="wb-button wb-button-danger"
              data-testid="wb-unsaved-discard"
              disabled={saving}
              onClick={onDiscard}
            >
              {discardLabel}
            </button>
            <button
              ref={saveRef}
              type="button"
              className="wb-button wb-button-primary"
              data-testid="wb-unsaved-save"
              disabled={saving}
              onClick={onSave}
            >
              {saveLabel}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
