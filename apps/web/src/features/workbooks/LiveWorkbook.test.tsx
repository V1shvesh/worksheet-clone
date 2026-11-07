import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  createEmptyWorkbook,
  getSheetName,
  readSheetOrder,
  setSheetName,
} from "@worksheet-clone/shared";

interface FakeConfig {
  document: Y.Doc;
  onStatus: (e: { status: string }) => void;
  onSynced: (e: { state: boolean }) => void;
  onAuthenticated: (e: { scope: string }) => void;
  onAuthenticationFailed: (e: { reason: string }) => void;
}
let config: FakeConfig | undefined;
vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProvider: class {
    destroy = vi.fn();
    constructor(c: FakeConfig) {
      config = c;
    }
  },
}));

const { createStore } = await import("../../app/store");
const { WorkbookDocProvider } = await import("../../crdt/WorkbookDoc");
const { LiveWorkbook } = await import("./LiveWorkbook");

let server: Y.Doc;
let sheetId: string;

// Plays the server: seeds the doc and syncs both ways with the client doc.
function connect(scope: "read-write" | "readonly") {
  const client = config?.document;
  if (!client) throw new Error("provider not created");
  act(() => {
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    config?.onStatus({ status: "connected" });
    config?.onAuthenticated({ scope });
    config?.onSynced({ state: true });
  });
  return client;
}

function remote(change: () => void) {
  const client = config?.document;
  if (!client) throw new Error("provider not created");
  const before = Y.encodeStateVector(client);
  change();
  act(() => Y.applyUpdate(client, Y.encodeStateAsUpdate(server, before)));
}

beforeEach(() => {
  server = new Y.Doc();
  createEmptyWorkbook(server);
  sheetId = readSheetOrder(server)[0] ?? "";
  render(
    <Provider store={createStore()}>
      <WorkbookDocProvider workbookId="wb-1">
        <LiveWorkbook />
      </WorkbookDocProvider>
    </Provider>,
  );
});
afterEach(cleanup);

describe("LiveWorkbook", () => {
  it("shows connection progress, then the live sheet list", () => {
    expect(screen.getByRole("status", { name: "Connection" })).toHaveTextContent("Connecting…");
    connect("read-write");
    expect(screen.getByRole("status", { name: "Connection" })).toHaveTextContent("Live");
    expect(screen.getByRole("list", { name: "Sheets" })).toHaveTextContent("Sheet1");
  });

  it("commits a rename as one transaction on Enter", () => {
    const client = connect("read-write");
    let transactions = 0;
    client.on("afterTransaction", () => transactions++);

    const field = screen.getByLabelText("First sheet name");
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "B" } });
    fireEvent.change(field, { target: { value: "Budget" } });
    expect(transactions).toBe(0);

    fireEvent.keyDown(field, { key: "Enter" });
    expect(transactions).toBe(1);
    expect(getSheetName(client, sheetId)).toBe("Budget");
  });

  it("follows remote renames, but never over the user's draft", () => {
    connect("read-write");
    const field = screen.getByLabelText("First sheet name");

    remote(() => setSheetName(server, sheetId, "From Bob"));
    expect(field).toHaveValue("From Bob");
    expect(screen.getByRole("list", { name: "Sheets" })).toHaveTextContent("From Bob");

    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "My draft" } });
    remote(() => setSheetName(server, sheetId, "From Bob again"));
    expect(field).toHaveValue("My draft");

    fireEvent.keyDown(field, { key: "Escape" });
    expect(field).toHaveValue("From Bob again");
  });

  it("is view-only for read-only access and never writes", () => {
    const client = connect("readonly");
    expect(screen.getByRole("status", { name: "Connection" })).toHaveTextContent("View only");

    const field = screen.getByLabelText("First sheet name");
    expect(field).toHaveAttribute("readonly");
    const before = Y.encodeStateVector(client);
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: "Sneaky" } });
    fireEvent.blur(field);
    expect(Y.encodeStateVector(client)).toEqual(before);
  });

  it("tells the user when access was denied", () => {
    act(() => config?.onAuthenticationFailed({ reason: "forbidden" }));
    expect(screen.getByRole("alert")).toHaveTextContent("don't have access");
  });
});
