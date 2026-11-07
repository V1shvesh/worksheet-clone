import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import {
  addSheet,
  DEFAULT_COL_COUNT,
  DEFAULT_ROW_COUNT,
  getColOrderArray,
  getRowOrderArray,
  getSchemaVersion,
  getSheetName,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  setSheetName,
} from "@worksheet-clone/shared";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { loadDocumentState, storeDocumentState } from "../../src/domain/documents.js";
import { createWorkbook } from "../../src/domain/workbooks.js";
import { connectCollab, waitFor, type CollabClient } from "../helpers/collab.js";
import { cleanupByEmailPattern, testEmails } from "../helpers/db.js";
import { signupClient, type TestClient } from "../helpers/http.js";

const emails = testEmails("test-collab-persist");
let app: FastifyInstance;
let baseUrl: string;
const clients: CollabClient[] = [];

beforeAll(async () => {
  app = buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterEach(async () => {
  clients.splice(0).forEach((client) => client.destroy());
  await waitFor(() => app.collab.getDocumentsCount() === 0);
  await cleanupByEmailPattern(emails.pattern);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function connect(user: TestClient, workbookId: string): Promise<CollabClient> {
  const client = connectCollab({
    baseUrl,
    workbookId,
    cookie: `session=${user.cookies.session}`,
  });
  clients.push(client);
  expect((await client.outcome).kind).toBe("synced");
  return client;
}

async function storedDoc(workbookId: string): Promise<Y.Doc | null> {
  const state = await loadDocumentState(workbookId);
  if (!state) return null;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc;
}

describe("collab persistence", () => {
  it("seeds a new workbook with one sheet and stores the seed immediately", async () => {
    const owner = await signupClient(app, emails.next());
    const workbook = await createWorkbook(owner.id, "Fresh");
    expect(await loadDocumentState(workbook.id)).toBeNull();

    const client = await connect(owner, workbook.id);
    const [sheetId] = readSheetOrder(client.doc);
    expect(sheetId).toBeDefined();

    // Stored before any edit, so a reload can't seed a different sheet id.
    const stored = await storedDoc(workbook.id);
    expect(stored && readSheetOrder(stored)).toEqual([sheetId]);
  });

  it("stores edits on last disconnect and serves them on the next load", async () => {
    const owner = await signupClient(app, emails.next());
    const workbook = await createWorkbook(owner.id, "Edited");

    const first = await connect(owner, workbook.id);
    const [sheetId = ""] = readSheetOrder(first.doc);
    setSheetName(first.doc, sheetId, "Budget");
    await waitFor(() => !first.provider.hasUnsyncedChanges);

    first.destroy();
    clients.length = 0;
    await waitFor(() => app.collab.getDocumentsCount() === 0);
    const stored = await storedDoc(workbook.id);
    expect(stored && getSheetName(stored, sheetId)).toBe("Budget");

    const second = await connect(owner, workbook.id);
    expect(readSheetOrder(second.doc)).toEqual([sheetId]);
    expect(getSheetName(second.doc, sheetId)).toBe("Budget");
  });

  it("migrates a stored v1 workbook (empty row/col orders) and stores the result", async () => {
    const owner = await signupClient(app, emails.next());
    const workbook = await createWorkbook(owner.id, "Old");
    const v1 = new Y.Doc();
    v1.getMap("meta").set("schemaVersion", 1);
    const sheetId = addSheet(v1, "Sheet1");
    v1.transact(() => {
      getRowOrderArray(v1, sheetId).delete(0, DEFAULT_ROW_COUNT);
      getColOrderArray(v1, sheetId).delete(0, DEFAULT_COL_COUNT);
    });
    await storeDocumentState(workbook.id, Y.encodeStateAsUpdate(v1));

    const first = await connect(owner, workbook.id);
    expect(readSheetOrder(first.doc)).toEqual([sheetId]);
    const rows = readRowOrder(first.doc, sheetId);
    const cols = readColOrder(first.doc, sheetId);
    expect(rows).toHaveLength(DEFAULT_ROW_COUNT);
    expect(cols).toHaveLength(DEFAULT_COL_COUNT);

    const stored = await storedDoc(workbook.id);
    expect(stored && getSchemaVersion(stored)).toBe(2);
    expect(stored && readRowOrder(stored, sheetId)).toEqual(rows);

    first.destroy();
    clients.length = 0;
    await waitFor(() => app.collab.getDocumentsCount() === 0);
    const second = await connect(owner, workbook.id);
    expect(readRowOrder(second.doc, sheetId)).toEqual(rows);
    expect(readColOrder(second.doc, sheetId)).toEqual(cols);
  });
});
