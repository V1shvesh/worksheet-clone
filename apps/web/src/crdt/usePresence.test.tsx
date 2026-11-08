import { act, cleanup, render, renderHook } from "@testing-library/react";
import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import { Provider } from "react-redux";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { createStore } from "../app/store";
import { authApi } from "../features/auth/authApi";
import { gridActions } from "../features/grid/gridSlice";
import { PresencePublisher } from "./PresencePublisher";
import { createPresencePublisher } from "./presence";
import { usePresence } from "./usePresence";
import { WorkbookDocContext } from "./WorkbookDoc";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ME = { id: "u-me", email: "me@example.com" };

async function setup() {
  const store = createStore();
  await store.dispatch(
    authApi.util.upsertQueryData("me", undefined, { user: { ...ME, createdAt: "" } } as never),
  );
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>
      <WorkbookDocContext.Provider value={{ doc, awareness, readOnly: false }}>
        {children}
      </WorkbookDocContext.Provider>
    </Provider>
  );
  return { store, awareness, wrapper };
}

function remote(awareness: Awareness, user: { id: string; email: string }, sheetId: string) {
  const other = new Awareness(new Y.Doc());
  other.on("update", ({ added, updated, removed }: Record<string, number[]>) =>
    applyAwarenessUpdate(
      awareness,
      encodeAwarenessUpdate(other, [...added!, ...updated!, ...removed!]),
      "remote",
    ),
  );
  createPresencePublisher(other, user).update(sheetId, null);
  return other;
}

describe("usePresence", () => {
  it("lists remote peers, flags the same user's other tab, and updates on change", async () => {
    const { awareness, wrapper } = await setup();
    const { result } = renderHook(() => usePresence(), { wrapper });
    expect(result.current).toEqual([]);

    let tab: Awareness;
    act(() => {
      remote(awareness, { id: "u-bob", email: "bob@example.com" }, "s1");
      tab = remote(awareness, ME, "s2");
    });
    const seen = result.current.map((p) => [p.user.email, p.isSelf]).sort();
    expect(seen).toEqual([
      ["bob@example.com", false],
      ["me@example.com", true],
    ]);

    act(() => tab.destroy());
    expect(result.current).toHaveLength(1);
  });

  it("is empty outside a workbook", () => {
    const store = createStore();
    const { result } = renderHook(() => usePresence(), {
      wrapper: ({ children }) => <Provider store={store}>{children}</Provider>,
    });
    expect(result.current).toEqual([]);
  });
});

describe("PresencePublisher", () => {
  it("publishes the open sheet and selection from the grid state, and the provider clears it on destroy", async () => {
    vi.useFakeTimers();
    const { store, wrapper } = await setup();
    const doc = new Y.Doc();
    const socket = new HocuspocusProviderWebsocket({
      url: "ws://127.0.0.1:1/collab",
      autoConnect: false,
    });
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: "w",
      document: doc,
    });
    const awareness = provider.awareness!;
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>
        <WorkbookDocContext.Provider value={{ doc, awareness, readOnly: false }}>
          {children}
        </WorkbookDocContext.Provider>
      </Provider>
    );
    void wrapper;

    render(<PresencePublisher />, { wrapper: Wrapper });
    expect(awareness.getLocalState()).toMatchObject({ user: { id: ME.id, email: ME.email } });

    act(() => {
      store.dispatch(gridActions.sheetOpened("s1"));
      store.dispatch(
        gridActions.selectionChanged({
          anchor: { rowId: "r1", colId: "c1" },
          focus: { rowId: "r2", colId: "c2" },
        }),
      );
      vi.advanceTimersByTime(300);
    });
    expect(awareness.getLocalState()).toMatchObject({
      sheetId: "s1",
      selection: { anchor: { rowId: "r1", colId: "c1" }, focus: { rowId: "r2", colId: "c2" } },
    });

    provider.destroy();
    expect(awareness.getLocalState()).toBeNull();
  });
});
