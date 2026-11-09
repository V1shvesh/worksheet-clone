import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createStore } from "../app/store";
import { collabActions } from "./collabSlice";
import { IDLE_HIDDEN_MS, IDLE_INPUT_MS, IDLE_UNSYNCED_GRACE_MS } from "./idle";
import { startIdleDisconnect } from "./idleDisconnect";

let visibility: "visible" | "hidden" = "visible";
const setVisibility = (next: "visible" | "hidden") => {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
};

/** Stands in for the provider: "connecting" pushes the doc's state to the server doc, like the sync handshake. */
function setup() {
  const server = new Y.Doc();
  const doc = new Y.Doc();
  const store = createStore();
  store.dispatch(collabActions.opened("w1"));
  store.dispatch(collabActions.statusChanged("connected"));
  store.dispatch(collabActions.syncedChanged(true));
  const calls: string[] = [];
  const provider = {
    connect() {
      calls.push("connect");
      Y.applyUpdate(server, Y.encodeStateAsUpdate(doc));
      store.dispatch(collabActions.statusChanged("connected"));
    },
    disconnect() {
      calls.push("disconnect");
      store.dispatch(collabActions.statusChanged("disconnected"));
    },
  };
  const stop = startIdleDisconnect({ provider, store });
  return { store, calls, doc, server, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("startIdleDisconnect", () => {
  it("hidden for 5 minutes disconnects and marks the store paused; visible again reconnects", () => {
    const { store, calls, stop } = setup();
    setVisibility("hidden");
    vi.advanceTimersByTime(IDLE_HIDDEN_MS - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["disconnect"]);
    expect(store.getState().collab.paused).toBe(true);
    setVisibility("visible");
    expect(calls).toEqual(["disconnect", "connect"]);
    expect(store.getState().collab.paused).toBe(false);
    stop();
  });

  it("a visible tab with no input for 30 minutes disconnects; throttled input events keep it alive and resume it", () => {
    const { calls, stop } = setup();
    vi.advanceTimersByTime(IDLE_INPUT_MS - 1000);
    window.dispatchEvent(new Event("pointermove"));
    vi.advanceTimersByTime(IDLE_INPUT_MS - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["disconnect"]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(calls).toEqual(["disconnect", "connect"]);
    stop();
  });

  it("unconfirmed changes delay the disconnect until confirmed; the grace period disconnects anyway", () => {
    const { store, calls, stop } = setup();
    store.dispatch(collabActions.unsyncedChangesChanged(1));
    setVisibility("hidden");
    vi.advanceTimersByTime(IDLE_HIDDEN_MS + 1000);
    expect(calls).toEqual([]);
    store.dispatch(collabActions.unsyncedChangesChanged(0));
    expect(calls).toEqual(["disconnect"]);

    setVisibility("visible");
    store.dispatch(collabActions.unsyncedChangesChanged(3));
    setVisibility("hidden");
    vi.advanceTimersByTime(IDLE_HIDDEN_MS + IDLE_UNSYNCED_GRACE_MS - 1);
    expect(calls).toEqual(["disconnect", "connect"]);
    vi.advanceTimersByTime(1);
    expect(calls).toEqual(["disconnect", "connect", "disconnect"]);
    stop();
  });

  it("does not idle-disconnect during access loss or while the provider is not connected", () => {
    const { store, calls, stop } = setup();
    store.dispatch(collabActions.accessLost({ kind: "tooLarge", unsaved: true }));
    setVisibility("hidden");
    vi.advanceTimersByTime(IDLE_HIDDEN_MS * 3);
    expect(calls).toEqual([]);
    expect(store.getState().collab.paused).toBe(false);
    stop();

    const second = setup();
    second.store.dispatch(collabActions.statusChanged("connecting"));
    vi.advanceTimersByTime(IDLE_HIDDEN_MS * 3);
    expect(second.calls).toEqual([]);
    second.stop();
  });

  it("edits made while paused are kept and reach the server on reconnect", () => {
    const { calls, doc, server, stop } = setup();
    setVisibility("hidden");
    vi.advanceTimersByTime(IDLE_HIDDEN_MS);
    expect(calls).toEqual(["disconnect"]);
    doc.getMap("m").set("k", "typed while away");
    expect(server.getMap("m").get("k")).toBeUndefined();
    window.dispatchEvent(new Event("pointerdown"));
    expect(calls).toEqual(["disconnect", "connect"]);
    expect(server.getMap("m").get("k")).toBe("typed while away");
    stop();
  });

  it("stop removes the listeners and timer", () => {
    const { calls, stop } = setup();
    setVisibility("hidden");
    stop();
    vi.advanceTimersByTime(IDLE_HIDDEN_MS * 2);
    expect(calls).toEqual([]);
  });
});
