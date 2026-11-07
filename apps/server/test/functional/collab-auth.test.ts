import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { addMember } from "../../src/domain/members.js";
import { createWorkbook } from "../../src/domain/workbooks.js";
import { authorizeCollabConnection } from "../../src/realtime/auth.js";
import { connectCollab, type CollabClient } from "../helpers/collab.js";
import { cleanupByEmailPattern, createUser, testEmails } from "../helpers/db.js";
import { signupClient } from "../helpers/http.js";

const emails = testEmails("test-collab-auth");
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
  await cleanupByEmailPattern(emails.pattern);
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

const sessionFor = (sessionId: string | null) => ({ readSessionId: () => sessionId });

describe("authorizeCollabConnection", () => {
  it("grants read-write to owners and editors, read-only to viewers", async () => {
    const owner = await createUser(emails.next());
    const editor = await createUser(emails.next());
    const viewer = await createUser(emails.next());
    const workbook = await createWorkbook(owner.id, "Doc");
    await addMember(owner.id, workbook.id, editor.email, "editor");
    await addMember(owner.id, workbook.id, viewer.email, "viewer");

    for (const [email, role, readOnly] of [
      [owner.email, "owner", false],
      [editor.email, "editor", false],
      [viewer.email, "viewer", true],
    ] as const) {
      const client = await signupOrLogin(email);
      const decision = await authorizeCollabConnection(
        sessionFor(client.sessionId),
        null,
        workbook.id,
      );
      expect(decision).toMatchObject({ readOnly, context: { role } });
    }
  });

  it("rejects missing sessions as unauthorized and non-members as forbidden", async () => {
    const owner = await createUser(emails.next());
    const stranger = await createUser(emails.next());
    const workbook = await createWorkbook(owner.id, "Private");
    const strangerSession = await signupOrLogin(stranger.email);

    await expect(
      authorizeCollabConnection(sessionFor(null), null, workbook.id),
    ).rejects.toMatchObject({ reason: "unauthorized" });
    await expect(
      authorizeCollabConnection(sessionFor(strangerSession.sessionId), null, workbook.id),
    ).rejects.toMatchObject({ reason: "forbidden" });
    await expect(
      authorizeCollabConnection(sessionFor(strangerSession.sessionId), null, "not-a-uuid"),
    ).rejects.toMatchObject({ reason: "forbidden" });
  });
});

describe("/collab over a real socket", () => {
  it("refuses a cross-origin upgrade with 403", async () => {
    const status = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/collab`, {
        headers: { origin: "https://evil.example.com" },
      });
      socket.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      socket.on("open", () => resolve(101));
    });
    expect(status).toBe(403);
  });

  it("refuses upgrades on other paths", async () => {
    const status = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/elsewhere`, {
        headers: { origin: baseUrl },
      });
      socket.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      socket.on("open", () => resolve(101));
    });
    expect(status).toBe(404);
  });

  it("denies a client without a session", async () => {
    const owner = await createUser(emails.next());
    const workbook = await createWorkbook(owner.id, "Doc");

    const client = connectCollab({ baseUrl, workbookId: workbook.id });
    clients.push(client);
    expect(await client.outcome).toEqual({ kind: "denied", reason: "unauthorized" });
  });

  it("syncs an owner read-write and a viewer read-only", async () => {
    const owner = await signupClient(app, emails.next());
    const viewer = await signupClient(app, emails.next());
    const workbook = await createWorkbook(owner.id, "Doc");
    await addMember(owner.id, workbook.id, viewer.email, "viewer");

    const ownerClient = connectCollab({
      baseUrl,
      workbookId: workbook.id,
      cookie: `session=${owner.cookies.session}`,
    });
    const viewerClient = connectCollab({
      baseUrl,
      workbookId: workbook.id,
      cookie: `session=${viewer.cookies.session}`,
    });
    clients.push(ownerClient, viewerClient);

    expect(await ownerClient.outcome).toEqual({ kind: "synced", scope: "read-write" });
    expect(await viewerClient.outcome).toEqual({ kind: "synced", scope: "readonly" });
  });
});

async function signupOrLogin(email: string): Promise<{ sessionId: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email, password: "correct-password" },
  });
  const signed = /session=([^;]+)/.exec(String(response.headers["set-cookie"]))?.[1] ?? "";
  const unsigned = app.unsignCookie(decodeURIComponent(signed));
  if (!unsigned.valid || !unsigned.value) throw new Error("login failed");
  return { sessionId: unsigned.value };
}
