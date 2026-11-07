import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { getSheetName, readSheetOrder, setSheetName } from "@worksheet-clone/shared";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { loadDocumentState } from "../../src/domain/documents.js";
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
});
