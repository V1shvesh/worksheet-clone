import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import { collabActions } from "../../crdt/collabSlice";
import type { IdSelection } from "./interaction/selection";

/** The cells marked by Cut (dashed outline) until they are pasted, replaced or abandoned. */
export interface CutMark {
  sheetId: string;
  /** Top-left and bottom-right cell ids, so the mark follows structure changes. */
  range: IdSelection;
}

export interface ClipboardState {
  cutMark: CutMark | null;
}

const initialState: ClipboardState = { cutMark: null };

// UI state only. Unlike the grid slice it survives sheet switches, because a cut on one
// sheet can be pasted on another.
export const clipboardSlice = createSlice({
  name: "clipboard",
  initialState,
  reducers: {
    cutMarked(state, action: PayloadAction<CutMark>) {
      state.cutMark = action.payload;
    },
    cutCleared(state) {
      state.cutMark = null;
    },
  },
  extraReducers: (builder) => {
    builder.addCase(collabActions.opened, () => initialState);
    builder.addCase(collabActions.closed, () => initialState);
  },
});

export const clipboardActions = clipboardSlice.actions;
