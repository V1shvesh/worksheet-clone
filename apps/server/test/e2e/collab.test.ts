import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addSheet,
  deleteSheet,
  getCell,
  deleteRows,
  insertRows,
  readColOrder,
  readRowOrder,
  encodeFormula,
  decodeFormula,
  formatSheetPrefix,
  getSheetName,
  readSheetOrder,
  setCell,
  setSheetName,
  parseCollabNotice,
  type CollabNotice,
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

  describe("rename notices", () => {
    function collectNotices(client: CollabClient): CollabNotice[] {
      const notices: CollabNotice[] = [];
      client.provider.on("stateless", ({ payload }: { payload: string }) => {
        const notice = parseCollabNotice(payload);
        if (notice) notices.push(notice);
      });
      return notices;
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

    async function trio() {
      const owner = await newUser("owner");
      const editor = await newUser("editor");
      const viewer = await newUser("viewer");
      const workbookId = await createWorkbook(owner, "Old");
      await share(owner, workbookId, editor, "editor");
      await share(owner, workbookId, viewer, "viewer");
      return { owner, editor, viewer, workbookId };
    }

    it("tells editor and viewer once when the owner renames the workbook over REST", async () => {
      const { owner, editor, viewer, workbookId } = await trio();
      const e = await open(editor, workbookId);
      const v = await open(viewer, workbookId);
      const editorNotices = collectNotices(e);
      const viewerNotices = collectNotices(v);

      const noop = await owner.request("PATCH", `/api/workbooks/${workbookId}`, { name: "Old" });
      expect(noop.status).toBe(200);
      const response = await owner.request("PATCH", `/api/workbooks/${workbookId}`, {
        name: "New",
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { workbook: WorkbookSummary }).workbook.name).toBe("New");

      await waitFor(() => editorNotices.length > 0 && viewerNotices.length > 0);
      await settle();
      const me = (await (await owner.request("GET", "/api/auth/me")).json()) as {
        user: { id: string; email: string };
      };
      const expected = {
        type: "workbookRenamed",
        by: { userId: me.user.id, email: owner.email },
        from: "Old",
        to: "New",
      };
      expect(editorNotices).toEqual([expected]);
      expect(viewerNotices).toEqual([expected]);
    });

    it("attributes a sheet rename to the editor who made it", async () => {
      const { owner, editor, workbookId } = await trio();
      const a = await open(owner, workbookId);
      const b = await open(editor, workbookId);
      const ownerNotices = collectNotices(a);
      const editorNotices = collectNotices(b);
      const [sheetId = ""] = readSheetOrder(a.doc);
      const before = getSheetName(a.doc, sheetId);

      setSheetName(b.doc, sheetId, "Budget");

      await waitFor(() => ownerNotices.length > 0);
      await settle();
      const me = (await (await editor.request("GET", "/api/auth/me")).json()) as {
        user: { id: string };
      };
      const expected = {
        type: "sheetRenamed",
        by: { userId: me.user.id, email: editor.email },
        sheetId,
        from: before,
        to: "Budget",
      };
      expect(ownerNotices).toEqual([expected]);
      // The sender receives its own notice too; clients filter by `by.userId`.
      expect(editorNotices).toEqual([expected]);
    });

    it("drops a viewer's rename and sends no notice", async () => {
      const { owner, viewer, workbookId } = await trio();
      const a = await open(owner, workbookId);
      const v = await open(viewer, workbookId);
      const ownerNotices = collectNotices(a);
      const [sheetId = ""] = readSheetOrder(a.doc);
      const before = getSheetName(a.doc, sheetId);

      setSheetName(v.doc, sheetId, "Hacked");
      await settle();

      expect(getSheetName(a.doc, sheetId)).toBe(before);
      expect(ownerNotices).toEqual([]);
    });

    it("sends no notice when a sheet is added or deleted", async () => {
      const { owner, editor, workbookId } = await trio();
      const a = await open(owner, workbookId);
      const b = await open(editor, workbookId);
      const ownerNotices = collectNotices(a);

      const added = addSheet(b.doc, "Extra");
      await waitFor(() => readSheetOrder(a.doc).includes(added));
      deleteSheet(b.doc, added);
      await waitFor(() => !readSheetOrder(a.doc).includes(added));
      await settle();

      expect(ownerNotices).toEqual([]);
    });
  });
  describe("row structure operations", () => {
    async function pair() {
      const alice = await newUser("alice");
      const bob = await newUser("bob");
      const workbookId = await createWorkbook(alice, "Structure");
      await share(alice, workbookId, bob, "editor");
      const a = await open(alice, workbookId);
      const b = await open(bob, workbookId);
      const [sheetId = ""] = readSheetOrder(a.doc);
      return { alice, bob, workbookId, a, b, sheetId };
    }

    it("an insert above a row and a concurrent edit of that row converge, and survive a restart", async () => {
      const { alice, workbookId, a, b, sheetId } = await pair();
      const rows = readRowOrder(a.doc, sheetId);
      const row5 = rows[4] ?? "";
      const colB = readColOrder(a.doc, sheetId)[1] ?? "";

      // Genuinely concurrent: B is detached from the socket (so it neither sends
      // nor receives) while A inserts and the server stores the insert. B then
      // edits B5 without knowing about the new row, and re-attaches.
      b.provider.detach();
      let inserted: string[] | null = null;
      a.doc.transact(() => {
        inserted = insertRows(a.doc, sheetId, 4, 1);
      });
      await waitFor(() => !a.provider.hasUnsyncedChanges);
      expect(readRowOrder(b.doc, sheetId)).toHaveLength(100); // B really has not seen it
      setCell(b.doc, sheetId, row5, colB, { v: "B's value" });
      b.provider.attach();

      const insertedId = (inserted as string[] | null)?.[0] ?? "";
      expect(insertedId).not.toBe("");
      for (const client of [a, b]) {
        await waitFor(() => readRowOrder(client.doc, sheetId).length === 101);
        await waitFor(() => getCell(client.doc, sheetId, row5, colB)?.v === "B's value");
        const order = readRowOrder(client.doc, sheetId);
        expect(order[4]).toBe(insertedId);
        expect(order[5]).toBe(row5);
        expect(getCell(client.doc, sheetId, insertedId, colB)).toBeUndefined();
      }
      await waitFor(() => !b.provider.hasUnsyncedChanges && !a.provider.hasUnsyncedChanges);

      // The server's copy: a fresh client sees the same, also after a restart.
      const fresh = await open(alice, workbookId);
      expect(readRowOrder(fresh.doc, sheetId)[5]).toBe(row5);
      expect(getCell(fresh.doc, sheetId, row5, colB)).toEqual({ v: "B's value" });
      await stack.restartServer();
      clients.splice(0).forEach((client) => client.destroy());
      const reloaded = await open(alice, workbookId);
      const order = readRowOrder(reloaded.doc, sheetId);
      expect(order[4]).toBe(insertedId);
      expect(order[5]).toBe(row5);
      expect(getCell(reloaded.doc, sheetId, order[5] ?? "", colB)).toEqual({ v: "B's value" });
      expect(getCell(reloaded.doc, sheetId, order[4] ?? "", colB)).toBeUndefined();
    });

    it("deleting a row inside a SUM range shrinks the range identically for everyone", async () => {
      const { a, b, sheetId } = await pair();
      const rows = readRowOrder(a.doc, sheetId);
      const cols = readColOrder(a.doc, sheetId);
      const rowId = (i: number) => rows[i] ?? "";
      const colId = (j: number) => cols[j] ?? "";
      const encodeCtx = {
        sheetId,
        sheetIdByName: () => undefined,
        resolver: () => ({ rowId, colId }),
      };
      setCell(a.doc, sheetId, rowId(0), colId(3), {
        f: encodeFormula("=SUM(A1:A3)", encodeCtx),
      });
      await waitFor(() => getCell(b.doc, sheetId, rowId(0), colId(3)) !== undefined);

      a.doc.transact(() => {
        expect(deleteRows(a.doc, sheetId, [rowId(2)])).toBe(true);
      });

      const expected = encodeFormula("=SUM(A1:A2)", encodeCtx);
      for (const client of [a, b]) {
        await waitFor(() => !readRowOrder(client.doc, sheetId).includes(rowId(2)));
        await waitFor(() => getCell(client.doc, sheetId, rowId(0), colId(3))?.f === expected);
        const rowsNow = readRowOrder(client.doc, sheetId);
        const stored = getCell(client.doc, sheetId, rowId(0), colId(3))?.f ?? "";
        expect(
          decodeFormula(stored, {
            sheetId,
            lookup: () => ({
              rowIndex: (id) => (rowsNow.includes(id) ? rowsNow.indexOf(id) : undefined),
              colIndex: (id) => (cols.includes(id) ? cols.indexOf(id) : undefined),
            }),
            sheetPrefix: (id) => formatSheetPrefix(id),
          }),
        ).toBe("=SUM(A1:A2)");
      }
    });
  });
});
