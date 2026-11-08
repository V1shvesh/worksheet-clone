import type { AppDispatch, RootState } from "../../../app/store";
import { gridActions } from "../gridSlice";
import type { GridView } from "../port";
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

export interface GridInteractionDeps {
  view: GridView;
  model: IdMapper;
  store: GridStore;
  sheetId: string;
}

export interface GridInteraction {
  dispose(): void;
}

/**
 * Wires GridView events to the interaction state machines and Redux. Plain TS:
 * the overlay and container call into this, the grid never does.
 */
export function createGridInteraction(deps: GridInteractionDeps): GridInteraction {
  const { view, model, store, sheetId } = deps;
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

  const offs = [
    view.on("pointerDown", (target, e) => {
      view.focus();
      applyPointer(pointerDown(pointer, target, e, pointerContext()));
    }),
    view.on("pointerMove", (target) => {
      applyPointer(pointerMove(pointer, target, pointerContext()));
    }),
    view.on("pointerUp", () => {
      applyPointer(pointerUp());
    }),
    view.on("contextMenu", (target) => {
      const selection = contextMenuSelection(target, pointerContext());
      if (selection) select(selection);
    }),
  ];

  return {
    dispose() {
      for (const off of offs.splice(0)) off();
      store.dispatch(gridActions.sheetClosed());
    },
  };
}
