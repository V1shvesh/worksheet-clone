import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  getSheetName,
  parseCollabNotice,
  readSheetOrder,
  setSheetName,
  type CollabNotice,
  type WorkbookSummary,
} from "@worksheet-clone/shared";
import { connectCollab, waitFor, type CollabClient } from "../helpers/collab.js";
import { HttpUser, startStack, type Stack } from "./stack.js";

// The outage is real: the table the document store writes to is renamed away,
// so every INSERT fails with Postgres's own "relation does not exist" error,
// and renamed back to end the outage. (A permissions revoke would not work:
// the test role owns the table. Stopping the container would take the whole
// stack down with it.) Retries are shortened to keep the test fast; the 1s..30s
// schedule itself is unit-tested.
let stack: Stack;
const clients: CollabClient[] = [];

beforeAll(async () => {
  stack = await startStack({ persistence: { retryDelayMs: () => 150 } });
}, 60_000);
afterEach(async () => {
  clients.splice(0).forEach((client) => client.destroy());
  await stack.pool.query("alter table if exists yjs_documents_offline rename to yjs_documents");
});
afterAll(() => stack?.stop());

describe("database outage while editing (real Postgres)", { timeout: 40_000 }, () => {
  it("keeps an edit made during the outage and persists it after recovery, even though everyone left", async () => {
    const alice = new HttpUser(stack, "e2e-save-failure-alice@example.com");
    await alice.signup();
    const created = await alice.request("POST", "/api/workbooks", { name: "Outage" });
    const workbookId = ((await created.json()) as { workbook: WorkbookSummary }).workbook.id;

    const notices: CollabNotice[] = [];
    const client = connectCollab({ baseUrl: stack.baseUrl, workbookId, cookie: alice.cookie });
    client.provider.on("stateless", ({ payload }: { payload: string }) => {
      const notice = parseCollabNotice(payload);
      if (notice) notices.push(notice);
    });
    clients.push(client);
    expect((await client.outcome).kind).toBe("synced");
    const [sheetId = ""] = readSheetOrder(client.doc);

    await stack.pool.query("alter table yjs_documents rename to yjs_documents_offline");
    setSheetName(client.doc, sheetId, "Written during outage");
    await waitFor(() => !client.provider.hasUnsyncedChanges);
    await waitFor(() => notices.some((n) => n.type === "saveFailing"), 6_000);

    // The last (only) client leaves while the database is still down.
    client.destroy();
    clients.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(stack.server.collab.documents.has(workbookId)).toBe(true);

    await stack.pool.query("alter table yjs_documents_offline rename to yjs_documents");
    await waitFor(() => stack.server.collab.getDocumentsCount() === 0, 5_000);

    const fresh = connectCollab({ baseUrl: stack.baseUrl, workbookId, cookie: alice.cookie });
    clients.push(fresh);
    expect((await fresh.outcome).kind).toBe("synced");
    expect(getSheetName(fresh.doc, sheetId)).toBe("Written during outage");
  });

  it("a connected client sees saveFailing, then saveRecovered, with the document still served", async () => {
    const bob = new HttpUser(stack, "e2e-save-failure-bob@example.com");
    await bob.signup();
    const created = await bob.request("POST", "/api/workbooks", { name: "Notices" });
    const workbookId = ((await created.json()) as { workbook: WorkbookSummary }).workbook.id;

    const notices: CollabNotice[] = [];
    const client = connectCollab({ baseUrl: stack.baseUrl, workbookId, cookie: bob.cookie });
    client.provider.on("stateless", ({ payload }: { payload: string }) => {
      const notice = parseCollabNotice(payload);
      if (notice) notices.push(notice);
    });
    clients.push(client);
    expect((await client.outcome).kind).toBe("synced");
    const [sheetId = ""] = readSheetOrder(client.doc);

    await stack.pool.query("alter table yjs_documents rename to yjs_documents_offline");
    setSheetName(client.doc, sheetId, "Still editing");
    await waitFor(() => notices.some((n) => n.type === "saveFailing"), 6_000);
    await stack.pool.query("alter table yjs_documents_offline rename to yjs_documents");
    await waitFor(() => notices.some((n) => n.type === "saveRecovered"), 6_000);
    expect(notices.map((n) => n.type).filter((type) => type.startsWith("save"))).toEqual([
      "saveFailing",
      "saveRecovered",
    ]);
  });
});
