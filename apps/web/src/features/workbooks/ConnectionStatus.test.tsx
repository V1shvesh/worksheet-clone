import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../../app/store";
import { collabActions } from "../../crdt/collabSlice";
import { ConnectionStatus, SAVING_DELAY_MS } from "./ConnectionStatus";

function setup() {
  const store = createStore();
  store.dispatch(collabActions.opened("w1"));
  store.dispatch(collabActions.statusChanged("connected"));
  store.dispatch(collabActions.syncedChanged(true));
  render(
    <Provider store={store}>
      <ConnectionStatus />
    </Provider>,
  );
  return store;
}
const status = () => screen.getByRole("status", { name: "Connection" });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ConnectionStatus", () => {
  it("shows saved, then 'Saving…' only after the delay (no flicker for quick saves)", () => {
    const store = setup();
    expect(status()).toHaveTextContent("All changes saved");

    act(() => void store.dispatch(collabActions.unsyncedChangesChanged(1)));
    expect(status()).toHaveTextContent("All changes saved");
    act(() => void vi.advanceTimersByTime(SAVING_DELAY_MS - 50));
    act(() => void store.dispatch(collabActions.unsyncedChangesChanged(0)));
    act(() => void vi.advanceTimersByTime(1000));
    expect(status()).toHaveTextContent("All changes saved");

    act(() => void store.dispatch(collabActions.unsyncedChangesChanged(1)));
    act(() => void vi.advanceTimersByTime(SAVING_DELAY_MS + 10));
    expect(status()).toHaveTextContent("Saving…");
  });

  it("explains offline with a pending-count tooltip", () => {
    const store = setup();
    act(() => {
      store.dispatch(collabActions.unsyncedChangesChanged(2));
      store.dispatch(collabActions.onlineChanged(false));
    });
    expect(status()).toHaveTextContent("Offline — changes are kept on this device");
    expect(status()).toHaveAttribute("title", "2 changes waiting to sync");
  });

  it("shows reconnecting and the save-failing message", () => {
    const store = setup();
    act(() => void store.dispatch(collabActions.saveFailed()));
    expect(status()).toHaveTextContent("Not saved — retrying");
    act(() => void store.dispatch(collabActions.statusChanged("disconnected")));
    expect(status()).toHaveTextContent("Reconnecting…");
  });
});
