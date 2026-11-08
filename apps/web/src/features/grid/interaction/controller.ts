import type * as Y from "yjs";
import type { AppDispatch, RootState } from "../../../app/store";
import { setCellInput } from "../commands/set-cell-input";
import { clearRange } from "../commands/clear-range";
import { gridActions } from "../gridSlice";
import { isHeaderHit, coordsEqual, type CellCoord, type GridView } from "../port";
import {
  cancelEditing,
  commitEditing,
  reduceKey,
  type Direction,
  type GridCommand,
  type KeyboardEnv,
  type KeyboardResult,
  type KeyboardState,
} from "./keyboard";
import {
  contextMenuSelection,
  initialPointerState,
  pointerDown,
  pointerMove,
  pointerUp,
  type PointerContext,
  type PointerResult,
  type PointerState,
} from "./pointer";
import {
  cellIdAt,
  idSelectionsEqual,
  resolveSelection,
  toIdSelection,
  type IdMapper,
  type IndexSelection,
} from "./selection";

export interface GridStore {
  dispatch: AppDispatch;
  getState: () => Pick<RootState, "grid">;
}

/** What the controller reads from the view model (SheetViewModel satisfies this). */
export interface InteractionModel extends IdMapper {
  getRawInput(cell: CellCoord): string;
}

export interface GridInteractionDeps {
  view: GridView;
  model: InteractionModel;
  store: GridStore;
  /**
   * `readOnly` is read on every action, so pass an object with a getter if access
   * can change while the sheet is open.
   */
  target: { doc: Y.Doc; readOnly: boolean };
  sheetId: string;
  /** Undo/redo for Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z and Ctrl+Y; the callee restores sheet and selection. */
  history?: { undo(): void; redo(): void };
}

export interface GridInteraction {
  /** Commit the current edit (the overlay editor's Enter/Tab/blur); no-op if not editing. */
  commitEdit(draft: string, move: Direction | null): void;
  /** Discard the current edit (Esc); no-op if not editing. */
  cancelEdit(): void;
  /** Keep the Redux draft in sync with the overlay editor's text. */
  updateDraft(text: string): void;
  dispose(): void;
}

/**
 * Wires GridView events to the interaction state machines and Redux. Plain TS:
 * the overlay and container call into this, the grid never does.
 */
export function createGridInteraction(deps: GridInteractionDeps): GridInteraction {
  const { view, model, store, target, sheetId, history } = deps;
  let pointer: PointerState = initialPointerState;

  store.dispatch(gridActions.sheetOpened(sheetId));

  const pointerContext = (): PointerContext => {
    const resolved = resolveSelection(store.getState().grid.selection, model);
    const { rowCount, colCount } = model.dimensions();
    return {
      selection: resolved && { anchor: resolved.anchor, focus: resolved.focus },
      rowCount,
      colCount,
    };
  };

  const select = (selection: IndexSelection) => {
    const next = toIdSelection(selection, model);
    if (!next || idSelectionsEqual(next, store.getState().grid.selection)) return;
    store.dispatch(gridActions.selectionChanged(next));
  };

  const applyPointer = (result: PointerResult) => {
    pointer = result.state;
    if (result.selection) select(result.selection);
  };

  const env = (): KeyboardEnv => ({
    ...model.dimensions(),
    readOnly: target.readOnly,
    getRawInput: (cell) => model.getRawInput(cell),
  });

  const keyboardState = (): KeyboardState => {
    const grid = store.getState().grid;
    const resolved = resolveSelection(grid.selection, model);
    const selection = resolved && { anchor: resolved.anchor, focus: resolved.focus };
    const e = grid.editing;
    if (!e) return { selection, editing: null };
    const row = model.rowIndexOf(e.rowId);
    const col = model.colIndexOf(e.colId);
    if (row === undefined || col === undefined) {
      // The edited cell was deleted by a collaborator; there is nothing to commit to.
      store.dispatch(gridActions.editingEnded());
      return { selection, editing: null };
    }
    return { selection, editing: { cell: { row, col }, draft: e.draft, mode: e.mode } };
  };

  const run = (command: GridCommand) => {
    switch (command.type) {
      case "setCellInput":
        setCellInput(target, sheetId, command.cell, command.raw);
        break;
      case "clearRange":
        clearRange(target, sheetId, command.range, model);
        break;
      case "undo":
      case "redo": {
        history?.[command.type]();
        view.focus();
        const restored = resolveSelection(store.getState().grid.selection, model);
        if (restored) view.scrollIntoView(restored.focus);
        break;
      }
    }
  };

  /** Pushes a reducer result into Redux, runs its commands, and follows the focus. */
  const apply = (prev: KeyboardState, result: KeyboardResult) => {
    for (const command of result.commands) run(command);
    const next = result.state;

    if (next.selection !== prev.selection && next.selection) select(next.selection);
    if (prev.editing && !next.editing) {
      store.dispatch(gridActions.editingEnded());
    } else if (!prev.editing && next.editing) {
      const id = cellIdAt(next.editing.cell, model);
      if (id) {
        store.dispatch(
          gridActions.editingStarted({ ...id, draft: next.editing.draft, mode: next.editing.mode }),
        );
      }
    }

    const before = prev.selection?.focus;
    const after = next.selection?.focus;
    if (after && (!before || !coordsEqual(before, after))) view.scrollIntoView(after);
  };

  const commitEdit = (draft: string, move: Direction | null) => {
    const prev = keyboardState();
    if (!prev.editing) return;
    apply(prev, commitEditing(prev, draft, move, env()));
  };

  const offs = [
    view.on("pointerDown", (t, e) => {
      view.focus();
      // Clicking elsewhere commits the open edit, like a spreadsheet.
      if (e.button === 0) commitEdit(store.getState().grid.editing?.draft ?? "", null);
      applyPointer(pointerDown(pointer, t, e, pointerContext()));
    }),
    view.on("pointerMove", (t) => {
      applyPointer(pointerMove(pointer, t, pointerContext()));
    }),
    view.on("pointerUp", () => {
      applyPointer(pointerUp());
    }),
    view.on("contextMenu", (t) => {
      const selection = contextMenuSelection(t, pointerContext());
      if (selection) select(selection);
    }),
    view.on("doubleClick", (t) => {
      if (isHeaderHit(t) || target.readOnly) return;
      const cell = cellIdAt(t, model);
      if (!cell) return;
      select({ anchor: t, focus: t });
      store.dispatch(
        gridActions.editingStarted({ ...cell, draft: model.getRawInput(t), mode: "edit" }),
      );
    }),
    view.on("keyDown", (key) => {
      const prev = keyboardState();
      apply(prev, reduceKey(prev, key, env()));
    }),
  ];

  return {
    commitEdit,
    cancelEdit() {
      const prev = keyboardState();
      if (prev.editing) apply(prev, cancelEditing(prev));
    },
    updateDraft(text) {
      if (store.getState().grid.editing) store.dispatch(gridActions.draftChanged(text));
    },
    dispose() {
      for (const off of offs.splice(0)) off();
      store.dispatch(gridActions.sheetClosed());
    },
  };
}
