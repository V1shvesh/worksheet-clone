import { useCallback } from "react";
import { useDispatch, useStore } from "react-redux";
import { readVisibleSheetOrder } from "@worksheet-clone/shared";
import type { AppDispatch, RootState } from "../../app/store";
import { useWorkbookUndo, type WorkbookUndo } from "../../crdt/undo";
import { useWorkbookDoc } from "../../crdt/WorkbookDoc";
import { gridActions } from "../grid/gridSlice";
import { useActiveSheet } from "../sheets/useActiveSheet";

/**
 * Undo/redo for the open workbook, shared by the toolbar and the keyboard chords.
 * After a step it cancels an open edit first, switches to the sheet the action
 * happened on, and restores the selection that action was made with.
 */
export function useUndoRedo() {
  const { doc } = useWorkbookDoc();
  const { canUndo, canRedo, undo, redo } = useWorkbookUndo();
  const { openSheet } = useActiveSheet();
  const dispatch = useDispatch<AppDispatch>();
  const store = useStore<RootState>();

  const run = useCallback(
    (step: WorkbookUndo["undo"]) => {
      // An uncommitted draft belongs to the state we are leaving.
      if (store.getState().grid.editing) dispatch(gridActions.editingEnded());
      const result = step();
      const context = result?.context;
      if (!context || !context.sheetId) return;
      if (!readVisibleSheetOrder(doc).includes(context.sheetId)) return;
      if (context.selection) {
        if (store.getState().grid.sheetId === context.sheetId) {
          dispatch(gridActions.selectionChanged(context.selection));
        } else {
          dispatch(
            gridActions.restoreRequested({
              sheetId: context.sheetId,
              selection: context.selection,
            }),
          );
        }
      }
      if (store.getState().grid.sheetId !== context.sheetId) openSheet(context.sheetId);
    },
    [dispatch, store, doc, openSheet],
  );

  return {
    canUndo,
    canRedo,
    undo: useCallback(() => run(undo), [run, undo]),
    redo: useCallback(() => run(redo), [run, redo]),
  };
}
