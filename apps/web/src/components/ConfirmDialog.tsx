import { useEffect, useRef } from "react";
import { Dialog } from "./Dialog";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus the safe choice so a stray Enter doesn't confirm a destructive action.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <Dialog title={title} onClose={onCancel}>
      <p>{message}</p>
      {error && <p role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" ref={cancelRef} onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="button-danger" onClick={onConfirm} disabled={busy}>
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
