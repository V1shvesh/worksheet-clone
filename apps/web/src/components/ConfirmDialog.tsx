import { useEffect, useId, useRef } from "react";

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
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus the safe choice so a stray Enter doesn't confirm a destructive action.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onCancel();
        }
      }}
    >
      <h2 id={titleId}>{title}</h2>
      <p>{message}</p>
      {error && <p role="alert">{error}</p>}
      <button type="button" ref={cancelRef} onClick={onCancel}>
        Cancel
      </button>
      <button type="button" onClick={onConfirm} disabled={busy}>
        {confirmLabel}
      </button>
    </div>
  );
}
