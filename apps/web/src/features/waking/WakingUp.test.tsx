import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../../app/store";
import { collabActions } from "../../crdt/collabSlice";
import type { RootState } from "../../app/store";
import { SOCKET_WAKING_DELAY_MS, WakingUp, selectFirstLoadPending } from "./WakingUp";

function setup() {
  const store = createStore();
  render(
    <Provider store={store}>
      <WakingUp />
    </Provider>,
  );
  return store;
}
const message = () => screen.queryByTestId("waking-up");
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WakingUp (collab socket)", () => {
  it("appears when the first sync is still pending after 2 s and goes once it syncs", () => {
    const store = setup();
    act(() => void store.dispatch(collabActions.opened("w1")));
    tick(SOCKET_WAKING_DELAY_MS - 1);
    expect(message()).toBeNull();
    tick(1);
    expect(message()).toHaveTextContent("Waking up the server…");
    expect(message()).toHaveAttribute("role", "status");

    act(() => {
      store.dispatch(collabActions.statusChanged("connected"));
      store.dispatch(collabActions.syncedChanged(true));
    });
    expect(message()).toBeNull();
  });

  it("stays quiet when the connection is quick", () => {
    const store = setup();
    act(() => void store.dispatch(collabActions.opened("w1")));
    tick(500);
    act(() => {
      store.dispatch(collabActions.statusChanged("connected"));
      store.dispatch(collabActions.syncedChanged(true));
    });
    tick(5000);
    expect(message()).toBeNull();
  });

  it("is not shown for a later drop (the header says Reconnecting…) or when offline", () => {
    const store = setup();
    act(() => {
      store.dispatch(collabActions.opened("w1"));
      store.dispatch(collabActions.statusChanged("connected"));
      store.dispatch(collabActions.syncedChanged(true));
      store.dispatch(collabActions.statusChanged("disconnected"));
    });
    tick(10_000);
    expect(message()).toBeNull();

    act(() => {
      store.dispatch(collabActions.closed());
      store.dispatch(collabActions.opened("w2"));
      store.dispatch(collabActions.onlineChanged(false));
    });
    tick(10_000);
    expect(message()).toBeNull();
  });

  it("is not shown without an open workbook or after access was denied", () => {
    const store = setup();
    tick(10_000);
    expect(message()).toBeNull();
    act(() => {
      store.dispatch(collabActions.opened("w1"));
      store.dispatch(collabActions.accessChanged("denied"));
    });
    tick(10_000);
    expect(message()).toBeNull();
  });
});

describe("first-load query selector", () => {
  const stateWith = (...queries: Record<string, unknown>[]) =>
    ({
      api: { queries: Object.fromEntries(queries.map((q, i) => [`q${i}`, q])) },
    }) as unknown as RootState;

  it("is true only for a pending session/workbook query with nothing cached yet", () => {
    expect(selectFirstLoadPending(stateWith({ endpointName: "me", status: "pending" }))).toBe(true);
    expect(
      selectFirstLoadPending(stateWith({ endpointName: "getWorkbook", status: "pending" })),
    ).toBe(true);
    expect(selectFirstLoadPending(stateWith())).toBe(false);
    // Already resolved, refetching in the background, or not a first-load endpoint.
    expect(
      selectFirstLoadPending(stateWith({ endpointName: "me", status: "fulfilled", data: {} })),
    ).toBe(false);
    expect(
      selectFirstLoadPending(stateWith({ endpointName: "me", status: "pending", data: {} })),
    ).toBe(false);
    expect(
      selectFirstLoadPending(stateWith({ endpointName: "listWorkbooks", status: "pending" })),
    ).toBe(false);
  });
});
