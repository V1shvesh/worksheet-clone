import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import {
  getSheetName,
  parseCollabNotice,
  readSheetOrder,
  setSheetName,
  type CollabNotice,
} from "@worksheet-clone/shared";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { loadDocumentState, storeDocumentState } from "../../src/domain/documents.js";
import { createWorkbook } from "../../src/domain/workbooks.js";
import { connectCollab, waitFor, type CollabClient } from "../helpers/collab.js";
import { cleanupByEmailPattern, testEmails } from "../helpers/db.js";
import { signupClient, type TestClient } from "../helpers/http.js";

// Real Hocuspocus + Postgres, but the store function is injected so the
// "database outage" can be switched on and off deterministically.
const emails = testEmails("test-collab-savefail");
let app: FastifyInstance;
let baseUrl: string;
let failing = false;
let failedAttempts = 0;
const clients: CollabClient[] = [];

beforeAll(async () => {
  app = buildApp({
    persistence: {
      retryDelayMs: () => 50,
      store: async (workbookId, state) => {
        if (failing) {
          failedAttempts += 1;
          throw new Error("simulated outage");
        }
        return storeDocumentState(workbookId, state);
      },
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterEach(async () => {
  failing = false;
  clients.splice(0).forEach((client) => client.destroy());
  await waitFor(() => app.collab.getDocumentsCount() === 0, 5_000);
  await cleanupByEmailPattern(emails.pattern);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

async function connect(user: TestClient, workbookId: string, notices?: CollabNotice[]) {
  const client = connectCollab({
    baseUrl,
    workbookId,
    cookie: `session=${user.cookies.session}`,
  });
  client.provider.on("stateless", ({ payload }: { payload: string }) => {
    const notice = parseCollabNotice(payload);
    if (notice) notices?.push(notice);
  });
  clients.push(client);
  expect((await client.outcome).kind).toBe("synced");
  return client;
}

describe("a failing database store", () => {
  it("keeps the document after the last client leaves, retries, and persists once the store recovers", async () => {
    const owner = await signupClient(app, emails.next());
    const workbook = await createWorkbook(owner.id, "Outage");
    const notices: CollabNotice[] = [];
    const client = await connect(owner, workbook.id, notices);
    const [sheetId = ""] = readSheetOrder(client.doc);

    failing = true;
    setSheetName(client.doc, sheetId, "Edited during outage");
    await waitFor(() => !client.provider.hasUnsyncedChanges);
    // The debounced store fails: clients are told.
    await waitFor(() => notices.some((n) => n.type === "saveFailing"), 6_000);

    client.destroy();
    clients.length = 0;
    // Retries keep failing and the document must stay loaded (unsaved).
    const seen = failedAttempts;
    await waitFor(() => failedAttempts >= seen + 3);
    expect(app.collab.documents.has(workbook.id)).toBe(true);
    const before = await loadDocumentState(workbook.id);
    const beforeDoc = new Y.Doc();
    Y.applyUpdate(beforeDoc, before ?? new Uint8Array());
    expect(getSheetName(beforeDoc, sheetId)).not.toBe("Edited during outage");

    failing = false;
    await waitFor(() => app.collab.getDocumentsCount() === 0, 5_000);
    const fresh = await connect(owner, workbook.id);
    expect(getSheetName(fresh.doc, sheetId)).toBe("Edited during outage");
  });

  it("sends saveFailing once and saveRecovered after the next success", async () => {
    const owner = await signupClient(app, emails.next());
    const workbook = await createWorkbook(owner.id, "Notices");
    const notices: CollabNotice[] = [];
    const client = await connect(owner, workbook.id, notices);
    const [sheetId = ""] = readSheetOrder(client.doc);

    failing = true;
    setSheetName(client.doc, sheetId, "A");
    await waitFor(() => notices.some((n) => n.type === "saveFailing"), 6_000);
    const seen = failedAttempts;
    await waitFor(() => failedAttempts >= seen + 2);
    failing = false;
    await waitFor(() => notices.some((n) => n.type === "saveRecovered"));
    expect(notices.map((n) => n.type).filter((type) => type.startsWith("save"))).toEqual([
      "saveFailing",
      "saveRecovered",
    ]);
  });
});
