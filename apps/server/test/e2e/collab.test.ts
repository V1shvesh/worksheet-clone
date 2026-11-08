import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addSheet,
  deleteSheet,
  getCell,
  getSheetName,
  readSheetOrder,
  setCell,
  setSheetName,
  type WorkbookSummary,
} from "@worksheet-clone/shared";
import { connectCollab, waitFor, type CollabClient } from "../helpers/collab.js";
import { HttpUser, startStack, type Stack } from "./stack.js";

let stack: Stack;
const clients: CollabClient[] = [];

beforeAll(async () => {
  stack = await startStack();
}, 60_000);
afterEach(() => {
  clients.splice(0).forEach((client) => client.destroy());
});
afterAll(() => stack?.stop());

let userCount = 0;
async function newUser(name: string): Promise<HttpUser> {
  const user = new HttpUser(stack, `e2e-collab-${name}-${++userCount}@example.com`);
  await user.signup();
  return user;
}

async function createWorkbook(owner: HttpUser, name: string): Promise<string> {
  const response = await owner.request("POST", "/api/workbooks", { name });
  return ((await response.json()) as { workbook: WorkbookSummary }).workbook.id;
}

async function share(owner: HttpUser, workbookId: string, user: HttpUser, role: string) {
  const response = await owner.request("POST", `/api/workbooks/${workbookId}/members`, {
    email: user.email,
    role,
  });
  expect(response.status).toBe(201);
}

async function open(user: HttpUser, workbookId: string, doc?: Y.Doc): Promise<CollabClient> {
  const client = connectCollab({ baseUrl: stack.baseUrl, workbookId, cookie: user.cookie, doc });
  clients.push(client);
  expect((await client.outcome).kind).toBe("synced");
  return client;
}

async function closeAll(): Promise<void> {
  clients.splice(0).forEach((client) => client.destroy());
  await waitFor(() => stack.server.collab.getDocumentsCount() === 0, 5_000);
}

describe("realtime collaboration (real server, real Postgres)", { timeout: 30_000 }, () => {
  it("two editors converge on concurrent edits", async () => {
    const alice = await newUser("alice");
    const bob = await newUser("bob");
    const workbookId = await createWorkbook(alice, "Shared");
    await share(alice, workbookId, bob, "editor");

    const a = await open(alice, workbookId);
    const b = await open(bob, workbookId);
    const [sheetId = ""] = readSheetOrder(a.doc);
    expect(readSheetOrder(b.doc)).toEqual([sheetId]);

    setSheetName(a.doc, sheetId, "Budget");
    setCell(b.doc, sheetId, "r1", "c1", { v: 42 });
    setCell(a.doc, sheetId, "r2", "c1", { f: "=[[r:r1,c:c1]]*2" });

    for (const client of [a, b]) {
      await waitFor(
        () =>
          getSheetName(client.doc, sheetId) === "Budget" &&
          getCell(client.doc, sheetId, "r1", "c1")?.v === 42 &&
          getCell(client.doc, sheetId, "r2", "c1")?.f !== undefined,
      );
    }
    expect(Y.encodeStateAsUpdate(a.doc)).toEqual(Y.encodeStateAsUpdate(b.doc));
  });

  it("drops a viewer's writes: never reach other clients or the database", async () => {
    const alice = await newUser("alice");
    const viewer = await newUser("viewer");
    const workbookId = await createWorkbook(alice, "Read only for some");
    await share(alice, workbookId, viewer, "viewer");

    const a = await open(alice, workbookId);
    const v = await open(viewer, workbookId);
    expect(v.provider.authorizedScope).toBe("readonly");
    const [sheetId = ""] = readSheetOrder(a.doc);

    setCell(v.doc, sheetId, "r1", "c1", { v: "viewer wrote this" });
    setCell(a.doc, sheetId, "r9", "c9", { v: "owner marker" });
    // The owner's later write reaches the viewer, so the viewer's earlier
    // write would have arrived by now if the server had accepted it.
    await waitFor(() => getCell(v.doc, sheetId, "r9", "c9")?.v === "owner marker");
    expect(getCell(a.doc, sheetId, "r1", "c1")).toBeUndefined();

    await closeAll();
    const reopened = await open(alice, workbookId);
    expect(getCell(reopened.doc, sheetId, "r1", "c1")).toBeUndefined();
    expect(getCell(reopened.doc, sheetId, "r9", "c9")?.v).toBe("owner marker");
  });

  it("unloads documents once the last client leaves", async () => {
    const alice = await newUser("alice");
    const workbookId = await createWorkbook(alice, "Sleepy");
    await open(alice, workbookId);
    expect(stack.server.collab.getDocumentsCount()).toBe(1);

    await closeAll();
    expect(stack.server.collab.getDocumentsCount()).toBe(0);
  });

  it("keeps the document across a server restart", async () => {
    const alice = await newUser("alice");
    const workbookId = await createWorkbook(alice, "Durable");
    const a = await open(alice, workbookId);
    const [sheetId = ""] = readSheetOrder(a.doc);
    setSheetName(a.doc, sheetId, "Survives restarts");
    setCell(a.doc, sheetId, "r1", "c1", { v: true });
    await waitFor(() => !a.provider.hasUnsyncedChanges);

    // Close the server while the client is still connected: shutdown must
    // flush the in-memory doc itself.
    await stack.restartServer();
    clients.splice(0).forEach((client) => client.destroy());

    const reopened = await open(alice, workbookId);
    expect(readSheetOrder(reopened.doc)).toEqual([sheetId]);
    expect(getSheetName(reopened.doc, sheetId)).toBe("Survives restarts");
    expect(getCell(reopened.doc, sheetId, "r1", "c1")).toEqual({ v: true });
  });

  it("repairs a workbook whose last two sheets were deleted concurrently: exactly one sheet remains", async () => {
    const alice = await newUser("alice");
    const bob = await newUser("bob");
    const workbookId = await createWorkbook(alice, "Racing deletes");
    await share(alice, workbookId, bob, "editor");

    const a = await open(alice, workbookId);
    const b = await open(bob, workbookId);
    const [first = ""] = readSheetOrder(a.doc);
    const second = addSheet(a.doc, "Sheet2");
    await waitFor(() => readSheetOrder(b.doc).length === 2);

    // Both deletes happen locally in the same tick, before either update can
    // reach the other client, so each still saw a sheet that would remain.
    deleteSheet(a.doc, first);
    deleteSheet(b.doc, second);

    await waitFor(
      () =>
        readSheetOrder(a.doc).length === 1 &&
        readSheetOrder(b.doc).length === 1 &&
        readSheetOrder(a.doc)[0] === readSheetOrder(b.doc)[0],
      10_000,
    );
    const [repaired = ""] = readSheetOrder(a.doc);
    expect([first, second]).not.toContain(repaired);
    expect(Y.encodeStateAsUpdate(a.doc)).toEqual(Y.encodeStateAsUpdate(b.doc));

    // Persisted: a fresh client sees the same single sheet, and no second
    // repair sneaks in later.
    await waitFor(() => !a.provider.hasUnsyncedChanges && !b.provider.hasUnsyncedChanges);
    await closeAll();
    const reopened = await open(alice, workbookId);
    expect(readSheetOrder(reopened.doc)).toEqual([repaired]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(readSheetOrder(reopened.doc)).toEqual([repaired]);
  });
});
