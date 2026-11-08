import { useUndoRedo } from "./useUndoRedo";
import "./Toolbar.css";

/** Undo/redo (and, below, formatting) for the open workbook; sits above the grid. */
export function Toolbar() {
  const { canUndo, canRedo, undo, redo } = useUndoRedo();
  return (
    <div className="toolbar" role="toolbar" aria-label="Toolbar" data-testid="toolbar">
      <button
        type="button"
        aria-label="Undo"
        title="Undo (Ctrl+Z)"
        disabled={!canUndo}
        onClick={undo}
      >
        ↶
      </button>
      <button
        type="button"
        aria-label="Redo"
        title="Redo (Ctrl+Shift+Z)"
        disabled={!canRedo}
        onClick={redo}
      >
        ↷
      </button>
    </div>
  );
}
