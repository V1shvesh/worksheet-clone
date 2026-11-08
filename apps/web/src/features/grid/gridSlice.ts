import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { collabActions } from "../../crdt/collabSlice";
import type { IdSelection } from "./interaction/selection";

/** The cell being edited, by id so a collaborator's row insert doesn't move it. */
export interface EditingState {
  rowId: string;
  colId: string;
  draft: string;
  /** `typing` replaced the content with the first keystroke; `edit` started from the raw input. */
  mode: "typing" | "edit";
}

export interface GridState {
  sheetId: string | null;
  selection: IdSelection | null;
  editing: EditingState | null;
}

const initialState: GridState = { sheetId: null, selection: null, editing: null };

// UI state for the open sheet only. Selection and the edited cell are ids, never
// indices; cell content stays in the Y.Doc.
export const gridSlice = createSlice({
  name: "grid",
  initialState,
  reducers: {
    sheetOpened(_state, action: PayloadAction<string>) {
      return { ...initialState, sheetId: action.payload };
    },
    sheetClosed() {
      return initialState;
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
