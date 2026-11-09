import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { COLLAB_CLOSE_CODES, type WorkbookSummary } from "@worksheet-clone/shared";
import { connectCollab, waitFor, type CollabClient } from "../helpers/collab.js";
import { HttpUser, startStack, type Stack } from "./stack.js";

const DOC_CAP = 300_000;
let stack: Stack;
const clients: CollabClient[] = [];

beforeAll(async () => {
  stack = await startStack({ limits: { docBytes: DOC_CAP } });
}, 60_000);
afterEach(() => clients.splice(0).forEach((client) => client.destroy()));
afterAll(() => stack?.stop());

describe("workbook size cap (real server, real Postgres)", { timeout: 30_000 }, () => {
  it("refuses an oversized update from a real provider and never stores it", async () => {
    const owner = new HttpUser(stack, `e2e-limits-${crypto.randomUUID()}@example.com`);
    await owner.signup();
    const created = await owner.request("POST", "/api/workbooks", { name: "Big" });
    const workbookId = ((await created.json()) as { workbook: WorkbookSummary }).workbook.id;

    const open = async (): Promise<CollabClient> => {
      const client = connectCollab({ baseUrl: stack.baseUrl, workbookId, cookie: owner.cookie });
      clients.push(client);
      expect((await client.outcome).kind).toBe("synced");
      return client;
    };
    const sender = await open();
    const peer = await open();
    sender.doc.getMap("scratch").set("fits", "a".repeat(20_000));
    await waitFor(() => peer.doc.getMap("scratch").get("fits") !== undefined);

    sender.doc.getMap("scratch").set("huge", "b".repeat(DOC_CAP * 2));
    expect((await sender.closed).code).toBe(COLLAB_CLOSE_CODES.tooLarge);

    // The peer never saw it and keeps editing.
    peer.doc.getMap("scratch").set("after", "still works");
    await waitFor(
      () =>
        stack.server.collab.documents.get(workbookId)?.getMap("scratch").get("after") !== undefined,
    );
    expect(peer.doc.getMap("scratch").get("huge")).toBeUndefined();

    // Restart: what was stored has the small value, not the oversized one.
    clients.splice(0).forEach((client) => client.destroy());
    await waitFor(() => stack.server.collab.getDocumentsCount() === 0, 5_000);
    await stack.restartServer();
    const reopened = new Y.Doc();
    const fresh = connectCollab({
      baseUrl: stack.baseUrl,
      workbookId,
      cookie: owner.cookie,
      doc: reopened,
    });
    clients.push(fresh);
    expect((await fresh.outcome).kind).toBe("synced");
    expect(reopened.getMap("scratch").get("fits")).toBe("a".repeat(20_000));
    expect(reopened.getMap("scratch").get("after")).toBe("still works");
    expect(reopened.getMap("scratch").get("huge")).toBeUndefined();
  });
});
