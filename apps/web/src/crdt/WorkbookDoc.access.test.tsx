import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

// The real provider would open a WebSocket; capture its config instead so
// tests can replay the close / re-authentication sequence by hand.
interface FakeProviderConfig {
  name: string;
  document: Y.Doc;
  onStatus: (e: { status: "connecting" | "connected" | "disconnected" }) => void;
  onAuthenticated: (e: { scope: string }) => void;
  onAuthenticationFailed: (e: { reason: string }) => void;
  onUnsyncedChanges: (e: { number: number }) => void;
  onClose: (e: { event: { code: number; reason: string } }) => void;
}
const providers: {
  config: FakeProviderConfig;
  destroy: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  instance: object;
}[] = [];
vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: class {
    destroy = vi.fn();
    disconnect = vi.fn();
    constructor(config: FakeProviderConfig) {
      providers.push({
        config,
        destroy: this.destroy,
        disconnect: this.disconnect,
        instance: this,
      });
    }
  },
}));

// What REST says about the workbook after a refused socket (RTK Query's fetch trips over jsdom).
let lookup: { isError: boolean; error?: { status: number } } = {
  isError: true,
  error: { status: 404 },
};
vi.mock("../features/workbooks/workbooksApi", () => ({
  workbooksApi: { endpoints: { getWorkbook: { initiate: () => () => Promise.resolve(lookup) } } },
}));

const { createStore } = await import("../app/store");
const { authApi } = await import("../features/auth/authApi");
const { WorkbookDocProvider, useWorkbookDoc } = await import("./WorkbookDoc");
const { LOCAL_ORIGIN } = await import("./origin");

beforeEach(() => {
  providers.length = 0;
  lookup = { isError: true, error: { status: 404 } };
});
afterEach(cleanup);

const dbNames = async () => (await indexedDB.databases()).map((d) => d.name);

async function mount() {
  const store = createStore();
  await store.dispatch(
    authApi.util.upsertQueryData("me", undefined, { user: { id: "u-7", email: "a@b.c" } } as never),
  );
  let resetDoc: (() => Promise<void>) | undefined;
  function Capture() {
    resetDoc = useWorkbookDoc().resetDoc;
    return null;
  }
  render(
    <Provider store={store}>
      <WorkbookDocProvider workbookId="wb-1">
        <Capture />
      </WorkbookDocProvider>
    </Provider>,
  );
  await waitFor(() => expect(store.getState().collab.cacheLoaded).toBe(true));
  const provider = () => {
    const current = providers.at(-1);
    if (!current) throw new Error("no provider");
    return current;
  };
  return { store, provider, resetDoc: () => resetDoc?.() };
}

/** The sequence the real provider produces for a 4205 close (see the commit message). */
function closeWith(provider: () => (typeof providers)[number], reason: string) {
  act(() => {
    provider().config.onClose({ event: { code: 4205, reason } });
    provider().config.onStatus({ status: "disconnected" });
  });
}
function reconnect(provider: () => (typeof providers)[number]) {
  act(() => {
    provider().config.onStatus({ status: "connected" });
    // startSync() resets the counter to 1 before the server has answered the token.
    provider().config.onUnsyncedChanges({ number: 1 });
  });
}
function typeLocally(doc: Y.Doc) {
  act(() => void doc.transact(() => doc.getMap("scratch").set("a", 1), LOCAL_ORIGIN));
}

describe("downgraded to viewer", () => {
  it("with unconfirmed edits: flags them (counted before the reconnect reset) and wipes the on-device copy", async () => {
    const { store, provider } = await mount();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    expect(await dbNames()).toContain("worksheet:u-7:wb-1");

    typeLocally(provider().config.document);
    act(() => provider().config.onUnsyncedChanges({ number: 1 }));
    closeWith(provider, "access-changed");
    reconnect(provider);
    act(() => provider().config.onAuthenticated({ scope: "readonly" }));

    expect(store.getState().collab.access).toBe("read-only");
    expect(store.getState().collab.accessLoss).toEqual({ kind: "downgraded", unsaved: true });
    await waitFor(async () => expect(await dbNames()).not.toContain("worksheet:u-7:wb-1"));
  });

  it("counts edits made between the close and the re-authentication", async () => {
    const { store, provider } = await mount();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    act(() => provider().config.onUnsyncedChanges({ number: 0 }));
    closeWith(provider, "access-changed");
    typeLocally(provider().config.document);
    reconnect(provider);
    act(() => provider().config.onAuthenticated({ scope: "readonly" }));
    expect(store.getState().collab.accessLoss).toEqual({ kind: "downgraded", unsaved: true });
  });

  it("without unconfirmed edits: just the notice, and the cache is left alone", async () => {
    const { store, provider } = await mount();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    typeLocally(provider().config.document);
    act(() => provider().config.onUnsyncedChanges({ number: 0 })); // acknowledged
    closeWith(provider, "access-changed");
    reconnect(provider);
    act(() => provider().config.onAuthenticated({ scope: "readonly" }));

    expect(store.getState().collab.accessLoss).toEqual({ kind: "downgraded", unsaved: false });
    expect(await dbNames()).toContain("worksheet:u-7:wb-1");
  });

  it("drops the 'unsaved' flag when the late acknowledgement turns out to cover everything", async () => {
    const { store, provider } = await mount();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    typeLocally(provider().config.document);
    act(() => provider().config.onUnsyncedChanges({ number: 1 }));
    closeWith(provider, "access-changed");
    reconnect(provider);
    act(() => provider().config.onAuthenticated({ scope: "readonly" }));
    expect(store.getState().collab.accessLoss?.unsaved).toBe(true);

    // The server already had the edit: its read-only sync acknowledges with "applied".
    act(() => provider().config.onUnsyncedChanges({ number: 0 }));
    expect(store.getState().collab.accessLoss).toEqual({ kind: "downgraded", unsaved: false });
  });

  it("is not a downgrade when the user was a viewer from the start", async () => {
    const { store, provider } = await mount();
    act(() => provider().config.onAuthenticated({ scope: "readonly" }));
    expect(store.getState().collab.accessLoss).toBeNull();
  });

  it("a re-granted editor clears the notice", async () => {
    const { store, provider } = await mount();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    act(() => provider().config.onAuthenticated({ scope: "readonly" }));
    expect(store.getState().collab.accessLoss).not.toBeNull();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    expect(store.getState().collab.accessLoss).toBeNull();
  });
});

describe("access refused", () => {
  it("removed: names it, wipes the on-device copy and reports unconfirmed edits", async () => {
    const { store, provider } = await mount();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    typeLocally(provider().config.document);
    closeWith(provider, "access-changed");
    act(() => provider().config.onAuthenticationFailed({ reason: "forbidden" }));

    expect(store.getState().collab.access).toBe("denied");
    expect(store.getState().collab.accessLoss).toEqual({ kind: "removed", unsaved: true });
    await waitFor(async () => expect(await dbNames()).not.toContain("worksheet:u-7:wb-1"));
  });

  it("deleted: the close reason says so once REST confirms the workbook is gone", async () => {
    const { store, provider } = await mount();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    closeWith(provider, "workbook-deleted");
    act(() => provider().config.onAuthenticationFailed({ reason: "forbidden" }));
    await waitFor(() =>
      expect(store.getState().collab.accessLoss).toEqual({ kind: "deleted", unsaved: false }),
    );
  });

  it("unexplained refusals (workbook still readable, or no close reason) get the neutral wording", async () => {
    lookup = { isError: false };
    const { store, provider } = await mount();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    closeWith(provider, "access-changed");
    act(() => provider().config.onAuthenticationFailed({ reason: "forbidden" }));
    await waitFor(() => expect(store.getState().collab.accessLoss?.kind).toBe("unavailable"));
  });

  it("a refusal on the very first connect (no close seen) is 'unavailable'", async () => {
    const { store, provider } = await mount();
    act(() => provider().config.onAuthenticationFailed({ reason: "forbidden" }));
    expect(store.getState().collab.accessLoss?.kind).toBe("unavailable");
  });
});

describe("document too large (4413)", () => {
  const closeTooLarge = (provider: () => (typeof providers)[number]) =>
    act(() => {
      provider().config.onClose({ event: { code: 4413, reason: "too-large" } });
      provider().config.onStatus({ status: "disconnected" });
    });

  it("stops editing, flags the dropped change, stops reconnecting and wipes the on-device copy", async () => {
    const { store, provider } = await mount();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    expect(await dbNames()).toContain("worksheet:u-7:wb-1");
    typeLocally(provider().config.document);
    act(() => provider().config.onUnsyncedChanges({ number: 1 }));

    closeTooLarge(provider);

    expect(store.getState().collab.accessLoss).toEqual({ kind: "tooLarge", unsaved: true });
    expect(store.getState().collab.access).toBe("read-only");
    // Reconnecting would resend the refused change forever.
    expect(provider().disconnect).toHaveBeenCalledTimes(1);
    await waitFor(async () => expect(await dbNames()).not.toContain("worksheet:u-7:wb-1"));
  });

  it("other close codes do not stop the provider", async () => {
    const { store, provider } = await mount();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    closeWith(provider, "access-changed");
    expect(provider().disconnect).not.toHaveBeenCalled();
    expect(store.getState().collab.accessLoss).toBeNull();
  });

  it("Reload (resetDoc) mounts a fresh replica that can edit again", async () => {
    const { store, provider, resetDoc } = await mount();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    typeLocally(provider().config.document);
    closeTooLarge(provider);

    await act(async () => void (await resetDoc()));

    expect(providers).toHaveLength(2);
    expect(store.getState().collab.accessLoss).toBeNull();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    expect(store.getState().collab.access).toBe("read-write");
  });
});

describe("resetDoc", () => {
  it("destroys doc, provider and cache, then mounts a fresh doc and provider from the server", async () => {
    const { store, provider, resetDoc } = await mount();
    act(() => provider().config.onAuthenticated({ scope: "read-write" }));
    typeLocally(provider().config.document);
    act(() => provider().config.onUnsyncedChanges({ number: 1 }));
    closeWith(provider, "access-changed");
    reconnect(provider);
    act(() => provider().config.onAuthenticated({ scope: "readonly" }));
    const old = provider();

    await act(async () => void (await resetDoc()));

    expect(old.destroy).toHaveBeenCalled();
    expect(old.config.document.isDestroyed).toBe(true);
    expect(providers).toHaveLength(2);
    const fresh = provider();
    expect(fresh).not.toBe(old);
    expect(fresh.config.document.getMap("scratch").get("a")).toBeUndefined();
    // New session state: no leftover banner, waiting for the server again.
    expect(store.getState().collab.accessLoss).toBeNull();
    expect(store.getState().collab.access).toBe("pending");
    await waitFor(() => expect(store.getState().collab.cacheLoaded).toBe(true));
    expect(fresh.config.document.getMap("scratch").get("a")).toBeUndefined();
  });
});

describe("opening as a viewer", () => {
  it("never loads an on-device copy (it could only hold edits the server drops) and deletes it", async () => {
    // A copy left behind by an editor session whose unsent edit the server will refuse now.
    const { IndexeddbPersistence } = await import("y-indexeddb");
    const stale = new Y.Doc();
    const persistence = new IndexeddbPersistence("worksheet:u-7:wb-1", stale);
    await persistence.whenSynced;
    stale.getMap("scratch").set("unsent", 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await persistence.destroy();
    expect(await dbNames()).toContain("worksheet:u-7:wb-1");

    const store = createStore();
    await store.dispatch(
      authApi.util.upsertQueryData("me", undefined, {
        user: { id: "u-7", email: "a@b.c" },
      } as never),
    );
    render(
      <Provider store={store}>
        <WorkbookDocProvider workbookId="wb-1" role="viewer">
          <span />
        </WorkbookDocProvider>
      </Provider>,
    );
    await waitFor(() => expect(providers).toHaveLength(1));
    await waitFor(async () => expect(await dbNames()).not.toContain("worksheet:u-7:wb-1"));
    const doc = providers[0]!.config.document;
    expect(doc.getMap("scratch").get("unsent")).toBeUndefined();
    expect(store.getState().collab.cacheLoaded).toBe(false);
  });
});
