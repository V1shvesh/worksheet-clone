import { describe, expect, it } from "vitest";
import { collabActions, collabSlice, syncStatus, type CollabState } from "./collabSlice";

const base: Pick<
  CollabState,
  "status" | "synced" | "hasSynced" | "unsyncedChanges" | "online" | "saveFailing" | "paused"
> = {
  status: "connected",
  synced: true,
  hasSynced: true,
  unsyncedChanges: 0,
  online: true,
  paused: false,
  saveFailing: false,
};

describe("syncStatus", () => {
  const cases: [string, Partial<typeof base>, ReturnType<typeof syncStatus>][] = [
    ["connected, synced, nothing pending", {}, "saved"],
    ["connected, synced, changes pending", { unsyncedChanges: 2 }, "saving"],
    ["save failing while connected", { saveFailing: true }, "saveFailing"],
    ["save failing and pending", { saveFailing: true, unsyncedChanges: 1 }, "saveFailing"],
    ["browser offline", { online: false }, "offline"],
    ["offline beats a stale 'connected'", { online: false, unsyncedChanges: 3 }, "offline"],
    ["offline beats save failing", { online: false, saveFailing: true }, "offline"],
    ["socket dropped after a sync", { status: "disconnected", synced: false }, "reconnecting"],
    ["reconnecting socket after a sync", { status: "connecting", synced: false }, "reconnecting"],
    ["connected again but not yet synced, after a sync", { synced: false }, "reconnecting"],
    [
      "first connection attempt",
      { status: "connecting", synced: false, hasSynced: false },
      "connecting",
    ],
    ["first handshake", { synced: false, hasSynced: false }, "connecting"],
    [
      "never synced and dropped",
      { status: "disconnected", synced: false, hasSynced: false },
      "reconnecting",
    ],
  ];
  it.each(cases)("%s", (_name, patch, expected) => {
    expect(syncStatus({ ...base, ...patch })).toBe(expected);
  });
});

describe("collab slice sync state", () => {
  it("tracks unsynced changes, online and the save-failing flag; opened resets them", () => {
    let state = collabSlice.reducer(undefined, collabActions.opened("w1"));
    state = collabSlice.reducer(state, collabActions.unsyncedChangesChanged(3));
    state = collabSlice.reducer(state, collabActions.onlineChanged(false));
    state = collabSlice.reducer(state, collabActions.saveFailed());
    expect(state).toMatchObject({ unsyncedChanges: 3, online: false, saveFailing: true });
    state = collabSlice.reducer(state, collabActions.saveRecovered());
    expect(state.saveFailing).toBe(false);
    state = collabSlice.reducer(state, collabActions.syncedChanged(true));
    expect(state.hasSynced).toBe(true);
    expect(collabSlice.reducer(state, collabActions.opened("w2"))).toMatchObject({
      unsyncedChanges: 0,
      online: true,
      hasSynced: false,
    });
  });
});

describe("collab slice save-failing flag", () => {
  it("is cleared when the socket drops (the server repeats it on reconnect)", () => {
    let state = collabSlice.reducer(undefined, collabActions.opened("w1"));
    state = collabSlice.reducer(state, collabActions.saveFailed());
    state = collabSlice.reducer(state, collabActions.statusChanged("connected"));
    expect(state.saveFailing).toBe(true);
    state = collabSlice.reducer(state, collabActions.statusChanged("disconnected"));
    expect(state.saveFailing).toBe(false);
  });
});

describe("collab slice paused (idle disconnect)", () => {
  const base = {
    status: "disconnected" as const,
    synced: false,
    hasSynced: true,
    unsyncedChanges: 0,
    online: true,
    saveFailing: false,
    paused: true,
  };

  it("shows paused instead of reconnecting, but offline still wins", () => {
    expect(syncStatus(base)).toBe("paused");
    expect(syncStatus({ ...base, online: false })).toBe("offline");
    expect(syncStatus({ ...base, paused: false })).toBe("reconnecting");
  });

  it("is cleared by a connected socket and by opening another workbook", () => {
    let state = collabSlice.reducer(undefined, collabActions.opened("w1"));
    state = collabSlice.reducer(state, collabActions.pausedChanged(true));
    expect(state.paused).toBe(true);
    expect(collabSlice.reducer(state, collabActions.statusChanged("connected")).paused).toBe(false);
    expect(collabSlice.reducer(state, collabActions.opened("w2")).paused).toBe(false);
  });
});
