import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { getSheetName, readSheetOrder, setSheetName } from "@worksheet-clone/shared";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { loadDocumentState } from "../../src/domain/documents.js";
import { addMember } from "../../src/domain/members.js";
import { createWorkbook } from "../../src/domain/workbooks.js";
import { connectCollab, waitFor, type CollabClient } from "../helpers/collab.js";
import { cleanupByEmailPattern, testEmails } from "../helpers/db.js";
import { signupClient, type TestClient } from "../helpers/http.js";

const emails = testEmails("test-collab-revoke");
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

interface Watched extends CollabClient {
  denials: string[];
  closeReasons: string[];
}

async function connect(user: TestClient, workbookId: string): Promise<Watched> {
  const client = connectCollab({ baseUrl, workbookId, cookie: `session=${user.cookies.session}` });
  const denials: string[] = [];
  client.provider.on("authenticationFailed", ({ reason }: { reason: string }) =>
    denials.push(reason),
  );
  const closeReasons: string[] = [];
  client.provider.on("close", ({ event }: { event: { reason: string } }) =>
    closeReasons.push(event.reason),
  );
  clients.push(client);
  expect((await client.outcome).kind).toBe("synced");
  return { ...client, denials, closeReasons };
}

async function setup(role: "editor" | "viewer") {
  const owner = await signupClient(app, emails.next());
  const member = await signupClient(app, emails.next());
  const workbook = await createWorkbook(owner.id, "Shared");
  await addMember(owner.id, workbook.id, member.email, role);
  const ownerClient = await connect(owner, workbook.id);
  const memberClient = await connect(member, workbook.id);
  const sheetId = readSheetOrder(ownerClient.doc)[0] ?? "";
  return { owner, member, workbook, ownerClient, memberClient, sheetId };
}

function rename(client: CollabClient, sheetId: string, name: string): void {
  setSheetName(client.doc, sheetId, name);
}

// The provider waits ~1s before reconnecting, then re-authenticates.
describe("revoking live access", { timeout: 15_000 }, () => {
  it("re-authenticates a demoted editor as read-only, so their edits stop landing", async () => {
    const { owner, member, workbook, ownerClient, memberClient, sheetId } = await setup("editor");

    rename(memberClient, sheetId, "Editor was here");
    await waitFor(() => getSheetName(ownerClient.doc, sheetId) === "Editor was here");

    const response = await app.inject({
      method: "PATCH",
      url: `/api/workbooks/${workbook.id}/members/${member.id}`,
      cookies: owner.cookies,
      payload: { role: "viewer" },
    });
    expect(response.statusCode).toBe(200);
    await waitFor(() => memberClient.provider.authorizedScope === "readonly", 5_000);

    // The server drops this write. (The demoted client keeps it in its own
    // replica — a read-only CRDT client can diverge locally, which is why the
    // web crdt layer refuses writes when read-only.)
    rename(memberClient, sheetId, "Should be dropped");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const serverDoc = app.collab.documents.get(workbook.id);
    expect(serverDoc && getSheetName(serverDoc, sheetId)).toBe("Editor was here");
    expect(getSheetName(ownerClient.doc, sheetId)).toBe("Editor was here");
  });

  it("cuts off a removed member: denied on reconnect, no further updates", async () => {
    const { owner, member, workbook, ownerClient, memberClient, sheetId } = await setup("viewer");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/workbooks/${workbook.id}/members/${member.id}`,
      cookies: owner.cookies,
    });
    expect(response.statusCode).toBe(204);
    await waitFor(() => memberClient.denials.includes("forbidden"), 5_000);
    expect(memberClient.closeReasons).toContain("access-changed");

    rename(ownerClient, sheetId, "Secret plan");
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(getSheetName(memberClient.doc, sheetId)).not.toBe("Secret plan");
  });

  it("disconnects everyone when the workbook is deleted, without storing it again", async () => {
    const { owner, workbook, ownerClient, memberClient } = await setup("editor");

    const response = await app.inject({
      method: "DELETE",
      url: `/api/workbooks/${workbook.id}`,
      cookies: owner.cookies,
    });
    expect(response.statusCode).toBe(204);

    await waitFor(
      () => ownerClient.denials.includes("forbidden") && memberClient.denials.includes("forbidden"),
      5_000,
    );
    await waitFor(() => !app.collab.documents.has(workbook.id), 5_000);
    // The close tells the client the workbook is gone (a removed member gets "access-changed").
    expect(ownerClient.closeReasons).toContain("workbook-deleted");
    expect(memberClient.closeReasons).toContain("workbook-deleted");
    expect(await loadDocumentState(workbook.id)).toBeNull();
  });
});
