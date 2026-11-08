import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { collabActions } from "../../crdt/collabSlice";
import type { CellRange } from "./port";
import type { IdSelection } from "./interaction/selection";

/** The cell being edited, by id so a collaborator's row insert doesn't move it. */
export interface EditingState {
  rowId: string;
  colId: string;
  draft: string;
  /** `typing` replaced the content with the first keystroke; `edit` started from the raw input. */
  mode: "typing" | "edit";
  /** `bar` when the formula bar started it (and so keeps DOM focus); otherwise the cell editor does. */
  source?: "bar";
}

export interface GridState {
  sheetId: string | null;
  selection: IdSelection | null;
  editing: EditingState | null;
  /**
   * A selection to apply when `sheetId` opens (undo/redo that switched sheets): the old
   * sheet's grid closes and the new one mounts afterwards, and both reset the slice.
   */
  restore: { sheetId: string; selection: IdSelection } | null;
  /** The cells (selection plus fill) a fill-handle drag would cover; visual indices, transient. */
  fillPreview: CellRange | null;
}

const initialState: GridState = {
  sheetId: null,
  selection: null,
  editing: null,
  restore: null,
  fillPreview: null,
};

// UI state for the open sheet only. Selection and the edited cell are ids, never
// indices; cell content stays in the Y.Doc.
export const gridSlice = createSlice({
  name: "grid",
  initialState,
  reducers: {
    sheetOpened(state, action: PayloadAction<string>) {
      const restore = state.restore;
      const here = restore?.sheetId === action.payload ? restore : null;
      return {
        ...initialState,
        sheetId: action.payload,
        selection: here ? here.selection : null,
        restore: here ? null : (restore ?? null),
      };
    },
    sheetClosed(state) {
      return { ...initialState, restore: state.restore };
    },
    restoreRequested(state, action: PayloadAction<{ sheetId: string; selection: IdSelection }>) {
      state.restore = action.payload;
    },
    selectionChanged(state, action: PayloadAction<IdSelection | null>) {
      state.selection = action.payload;
    },
    editingStarted(state, action: PayloadAction<EditingState>) {
      state.editing = action.payload;
    },
    draftChanged(state, action: PayloadAction<string>) {
      if (state.editing) state.editing.draft = action.payload;
    },
    fillPreviewChanged(state, action: PayloadAction<CellRange | null>) {
      state.fillPreview = action.payload;
    },
    editingEnded(state) {
      state.editing = null;
    },
  },
  extraReducers: (builder) => {
    // A different workbook never inherits the previous one's selection.
    builder.addCase(collabActions.opened, () => initialState);
    builder.addCase(collabActions.closed, () => initialState);
  },
});

export const gridActions = gridSlice.actions;
