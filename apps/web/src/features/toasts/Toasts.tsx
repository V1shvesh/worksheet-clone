import { useEffect } from "react";
import { useDispatch, useSelector } from "react-redux";
import type { RootState } from "../../app/store";
import { toastsActions, type Toast } from "./toastsSlice";
import "./Toasts.css";

export const TOAST_DURATION_MS = 4000;

/** Bottom-right stack of transient notifications; each dismisses itself after a few seconds. */
export function Toasts() {
  const items = useSelector((state: RootState) => state.toasts.items);
  return (
    <div className="toasts">
      {items.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const dispatch = useDispatch();
  const { id } = toast;

  useEffect(() => {
    const timer = setTimeout(() => dispatch(toastsActions.dismissed(id)), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [id, dispatch]);

  return (
    <div className="toast" role="status" data-testid="toast" title={toast.title}>
      <span className="toast-message">{toast.message}</span>
      <button
        type="button"
        className="toast-dismiss"
        aria-label="Dismiss"
        onClick={() => dispatch(toastsActions.dismissed(id))}
      >
        ×
      </button>
    </div>
  );
}
