import { createSlice, type PayloadAction } from "@reduxjs/toolkit";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";
/** What the server granted; "pending" until it has answered. */
export type CollabAccess = "pending" | "read-write" | "read-only" | "denied";

export interface CollabState {
  workbookId: string | null;
  status: ConnectionStatus;
  synced: boolean;
  access: CollabAccess;
  /** The on-device copy has been applied to the doc (it may already hold content before the server sync). */
  cacheLoaded: boolean;
  /** True once this mount has completed a server sync (so a later drop is "reconnecting", not "connecting"). */
  hasSynced: boolean;
  /** The provider's count of local updates the server hasn't acknowledged. */
  unsyncedChanges: number;
  /** navigator.onLine. */
  online: boolean;
  /** The server told us it can't persist (set by the notice handler). */
  saveFailing: boolean;
}

export type SyncStatus =
  "saved" | "saving" | "offline" | "reconnecting" | "connecting" | "saveFailing";

/**
 * What the header indicator says. "Saved" means the server has the change:
 * connected, synced and nothing unacknowledged. Offline wins over everything
 * (the browser says there is no network, so a socket state is meaningless).
 */
export function syncStatus(
  state: Pick<
    CollabState,
    "status" | "synced" | "hasSynced" | "unsyncedChanges" | "online" | "saveFailing"
  >,
): SyncStatus {
  if (!state.online) return "offline";
  if (state.status !== "connected" || !state.synced) {
    return state.hasSynced || state.status === "disconnected" ? "reconnecting" : "connecting";
  }
  if (state.saveFailing) return "saveFailing";
  return state.unsyncedChanges > 0 ? "saving" : "saved";
}

const initialState: CollabState = {
  workbookId: null,
  status: "disconnected",
  synced: false,
  access: "pending",
  cacheLoaded: false,
  hasSynced: false,
  unsyncedChanges: 0,
  online: true,
  saveFailing: false,
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
      // The server repeats saveFailing to every new connection, so a stale flag can't outlive a drop.
      if (action.payload === "disconnected") state.saveFailing = false;
    },
    syncedChanged(state, action: PayloadAction<boolean>) {
      state.synced = action.payload;
      if (action.payload) state.hasSynced = true;
    },
    cacheLoaded(state) {
      state.cacheLoaded = true;
    },
    unsyncedChangesChanged(state, action: PayloadAction<number>) {
      state.unsyncedChanges = action.payload;
    },
    onlineChanged(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
    },
    saveFailed(state) {
      state.saveFailing = true;
    },
    saveRecovered(state) {
      state.saveFailing = false;
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
