import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createEmptyWorkbook, getSheetName, readSheetOrder } from "@worksheet-clone/shared";

// The real provider would open a WebSocket; capture its config instead so
// tests can drive the connection events by hand.
interface FakeProviderConfig {
  name: string;
  url: string;
  document: Y.Doc;
  onStatus: (e: { status: "connecting" | "connected" | "disconnected" }) => void;
  onSynced: (e: { state: boolean }) => void;
  onAuthenticated: (e: { scope: string }) => void;
  onAuthenticationFailed: (e: { reason: string }) => void;
}
const providers: { config: FakeProviderConfig; destroy: ReturnType<typeof vi.fn> }[] = [];
vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: class {
    destroy = vi.fn();
    constructor(config: FakeProviderConfig) {
      providers.push({ config, destroy: this.destroy });
    }
  },
}));

const { createStore } = await import("../app/store");
const { WorkbookDocProvider, collabUrl, useWorkbookDoc } = await import("./WorkbookDoc");
const { useDocValue, useSheetName, useSheetOrder, shallowEqualArrays } =
  await import("./useDocValue");
const { renameSheet } = await import("./mutations");
const { LOCAL_ORIGIN } = await import("./origin");

beforeEach(() => {
  providers.length = 0;
});
afterEach(cleanup);

function seededDoc(): [Y.Doc, string] {
  const doc = new Y.Doc();
  createEmptyWorkbook(doc);
  return [doc, readSheetOrder(doc)[0] ?? ""];
}

describe("collabUrl", () => {
  it("uses ws on http and wss on https, same host", () => {
    expect(collabUrl({ protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173/collab",
    );
    expect(collabUrl({ protocol: "https:", host: "app.example.com" })).toBe(
      "wss://app.example.com/collab",
    );
  });
});

describe("mutations", () => {
  it("renames in exactly one LOCAL_ORIGIN transaction", () => {
    const [doc, sheetId] = seededDoc();
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tx: Y.Transaction) => origins.push(tx.origin));

    expect(renameSheet(doc, false, sheetId, "  Budget  ")).toEqual({ ok: true });
    expect(getSheetName(doc, sheetId)).toBe("Budget");
    expect(origins).toEqual([LOCAL_ORIGIN]);
  });

  it("refuses writes while read-only and ignores blank names", () => {
    const [doc, sheetId] = seededDoc();
    const before = Y.encodeStateVector(doc);

    expect(renameSheet(doc, true, sheetId, "Nope").ok).toBe(false);
    expect(renameSheet(doc, false, sheetId, "   ").ok).toBe(false);
    expect(Y.encodeStateVector(doc)).toEqual(before);
  });
});

describe("useDocValue", () => {
  it("re-renders on relevant changes only", () => {
    const [doc, sheetId] = seededDoc();
    let renders = 0;
    function Order() {
      renders++;
      const order = useDocValue(doc, readSheetOrder, shallowEqualArrays);
      return <p>{order.length} sheets</p>;
    }
    render(<Order />);
    expect(screen.getByText("1 sheets")).toBeInTheDocument();
    const afterMount = renders;

    // Renaming leaves the order unchanged, so no re-render.
    act(() => {
      renameSheet(doc, false, sheetId, "Renamed");
    });
    expect(renders).toBe(afterMount);

    // A remote peer adding a sheet does change it.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    remote.transact(() => {
      remote.getArray<string>("sheetOrder").push(["s2"]);
      remote.getMap("sheets").set("s2", new Y.Map());
    });
    act(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(remote, Y.encodeStateVector(doc))));
    expect(screen.getByText("2 sheets")).toBeInTheDocument();
  });
});

describe("WorkbookDocProvider", () => {
  function Probe() {
    const { readOnly } = useWorkbookDoc();
    const [sheetId = ""] = useSheetOrder();
    const name = useSheetName(sheetId);
    return (
      <p>
        {readOnly ? "read-only" : "read-write"} / {name ?? "no sheet"}
      </p>
    );
  }

  function renderWith(workbookId: string, store = createStore()) {
    const view = render(
      <Provider store={store}>
        <WorkbookDocProvider workbookId={workbookId}>
          <Probe />
        </WorkbookDocProvider>
      </Provider>,
    );
    return { ...view, store };
  }

  it("connects to the workbook and mirrors connection events into Redux", () => {
    const { store } = renderWith("wb-1");
    const provider = providers.at(-1);
    expect(provider?.config.name).toBe("wb-1");
    expect(provider?.config.url).toBe(`ws://${window.location.host}/collab`);
    expect(store.getState().collab).toMatchObject({ workbookId: "wb-1", status: "connecting" });

    act(() => provider?.config.onStatus({ status: "connected" }));
    act(() => provider?.config.onSynced({ state: true }));
    expect(store.getState().collab).toMatchObject({ status: "connected", synced: true });

    act(() => provider?.config.onStatus({ status: "disconnected" }));
    expect(store.getState().collab).toMatchObject({ status: "disconnected", synced: false });
  });

  it("stays read-only until the server grants read-write", () => {
    renderWith("wb-1");
    const provider = providers.at(-1);
    expect(screen.getByText(/^read-only/)).toBeInTheDocument();

    act(() => provider?.config.onAuthenticated({ scope: "read-write" }));
    expect(screen.getByText(/^read-write/)).toBeInTheDocument();

    act(() => provider?.config.onAuthenticated({ scope: "readonly" }));
    expect(screen.getByText(/^read-only/)).toBeInTheDocument();
  });

  it("records a denied connection", () => {
    const { store } = renderWith("wb-1");
    act(() => providers.at(-1)?.config.onAuthenticationFailed({ reason: "forbidden" }));
    expect(store.getState().collab.access).toBe("denied");
  });

  it("shows doc content as it arrives from the server", () => {
    renderWith("wb-1");
    const doc = providers.at(-1)?.config.document;
    const [serverDoc] = seededDoc();
    act(() => doc && Y.applyUpdate(doc, Y.encodeStateAsUpdate(serverDoc)));
    expect(screen.getByText(/Sheet1/)).toBeInTheDocument();
  });

  it("tears down on unmount and when switching workbooks", () => {
    const store = createStore();
    const { rerender, unmount } = renderWith("wb-1", store);
    const first = providers.at(-1);

    rerender(
      <Provider store={store}>
        <WorkbookDocProvider workbookId="wb-2">
          <Probe />
        </WorkbookDocProvider>
      </Provider>,
    );
    expect(first?.destroy).toHaveBeenCalled();
    expect(first?.config.document.isDestroyed).toBe(true);
    expect(providers.at(-1)?.config.name).toBe("wb-2");

    unmount();
    expect(providers.at(-1)?.destroy).toHaveBeenCalled();
    expect(store.getState().collab.workbookId).toBeNull();
  });
});
