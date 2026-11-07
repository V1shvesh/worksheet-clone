import { useId, type ReactNode } from "react";

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

export function Dialog({ title, onClose, children }: DialogProps) {
  const titleId = useId();

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onClose();
        }
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
    </div>
  );
}
