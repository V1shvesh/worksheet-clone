import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
/** What the server granted; "pending" until it has answered. */
export type CollabAccess = "pending" | "read-write" | "read-only" | "denied";

export interface CollabState {
  workbookId: string | null;
  status: ConnectionStatus;
  synced: boolean;
  access: CollabAccess;
}

const initialState: CollabState = {
  workbookId: null,
  status: "disconnected",
  synced: false,
  access: "pending",
};

// UI state about the live connection only — document content never goes in
// Redux (it lives in the Y.Doc).
export const collabSlice = createSlice({
  name: "collab",
  initialState,
  reducers: {
    opened(_state, action: PayloadAction<string>) {
      return { ...initialState, workbookId: action.payload, status: "connecting" };
    },
    statusChanged(state, action: PayloadAction<ConnectionStatus>) {
      state.status = action.payload;
      if (action.payload !== "connected") {
        state.synced = false;
      }
    },
    syncedChanged(state, action: PayloadAction<boolean>) {
      state.synced = action.payload;
    },
    accessChanged(state, action: PayloadAction<CollabAccess>) {
      state.access = action.payload;
    },
    closed() {
      return initialState;
    },
  },
});

export const collabActions = collabSlice.actions;
