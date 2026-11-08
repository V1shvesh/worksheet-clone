import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "../../app/store";
import { TOAST_DURATION_MS, Toasts } from "./Toasts";
import { toastsActions } from "./toastsSlice";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup() {
  const store = createStore();
  render(
    <Provider store={store}>
      <Toasts />
    </Provider>,
  );
  return store;
}

describe("Toasts", () => {
  it("shows a toast with its tooltip and removes it after the timeout", () => {
    const store = setup();
    act(() => void store.dispatch(toastsActions.pushed("hello", "bob@x.com")));
    const toast = screen.getByTestId("toast");
    expect(toast).toHaveTextContent("hello");
    expect(toast).toHaveAttribute("title", "bob@x.com");
    expect(toast).toHaveAttribute("role", "status");

    act(() => void vi.advanceTimersByTime(TOAST_DURATION_MS + 1));
    expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
  });

  it("dismisses on click", () => {
    const store = setup();
    act(() => void store.dispatch(toastsActions.pushed("bye")));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("toast")).not.toBeInTheDocument();
  });

  it("shows at most three", () => {
    const store = setup();
    act(() => {
      for (let i = 0; i < 5; i++) store.dispatch(toastsActions.pushed(`m${i}`));
    });
    expect(screen.getAllByTestId("toast")).toHaveLength(3);
  });
});
