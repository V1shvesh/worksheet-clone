import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { addMember } from "../../src/domain/members.js";
import { cleanupByEmailPattern, testEmails } from "../helpers/db.js";
import { signupClient, type TestClient } from "../helpers/http.js";

const emails = testEmails("test-http-wb");
let app: FastifyInstance;

beforeEach(() => {
  app = buildApp();
});
afterEach(() => cleanupByEmailPattern(emails.pattern));
afterAll(() => pool.end());

async function create(client: TestClient, name = "Budget") {
  const response = await app.inject({
    method: "POST",
    url: "/api/workbooks",
    cookies: client.cookies,
    payload: { name },
  });
  return response.json().workbook as { id: string; name: string; role: string };
}

describe("/api/workbooks", () => {
  it("requires a session", async () => {
    for (const [method, url] of [
      ["GET", "/api/workbooks"],
      ["POST", "/api/workbooks"],
      ["DELETE", `/api/workbooks/${crypto.randomUUID()}`],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: "UNAUTHORIZED" } });
    }
  });

  it("creates a workbook and lists it with ISO timestamps", async () => {
    const owner = await signupClient(app, emails.next());

    const created = await app.inject({
      method: "POST",
      url: "/api/workbooks",
      cookies: owner.cookies,
      payload: { name: "  Budget  " },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().workbook).toMatchObject({ name: "Budget", role: "owner" });

    const list = await app.inject({ method: "GET", url: "/api/workbooks", cookies: owner.cookies });
    expect(list.json().workbooks).toEqual([
      expect.objectContaining({
        name: "Budget",
        role: "owner",
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    ]);
  });

  it("rejects an invalid name with VALIDATION_ERROR", async () => {
    const owner = await signupClient(app, emails.next());
    const response = await app.inject({
      method: "POST",
      url: "/api/workbooks",
      cookies: owner.cookies,
      payload: { name: "   " },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("returns 404 to non-members and for malformed ids", async () => {
    const owner = await signupClient(app, emails.next());
    const stranger = await signupClient(app, emails.next());
    const workbook = await create(owner);

    for (const url of [`/api/workbooks/${workbook.id}`, "/api/workbooks/not-a-uuid"]) {
      const response = await app.inject({ method: "GET", url, cookies: stranger.cookies });
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    }
  });

  it("lets members read but only the owner rename or delete", async () => {
    const owner = await signupClient(app, emails.next());
    const viewer = await signupClient(app, emails.next());
    const workbook = await create(owner);
    await addMember(owner.id, workbook.id, viewer.email, "viewer");

    const read = await app.inject({
      method: "GET",
      url: `/api/workbooks/${workbook.id}`,
      cookies: viewer.cookies,
    });
    expect(read.json().workbook).toMatchObject({ id: workbook.id, role: "viewer" });

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/workbooks/${workbook.id}`,
      cookies: viewer.cookies,
      payload: { name: "Mine now" },
    });
    expect(rename.statusCode).toBe(403);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/workbooks/${workbook.id}`,
      cookies: viewer.cookies,
    });
    expect(del.statusCode).toBe(403);
    expect(del.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("renames and deletes as owner", async () => {
    const owner = await signupClient(app, emails.next());
    const workbook = await create(owner);

    const rename = await app.inject({
      method: "PATCH",
      url: `/api/workbooks/${workbook.id}`,
      cookies: owner.cookies,
      payload: { name: "Renamed" },
    });
    expect(rename.json().workbook).toMatchObject({ name: "Renamed" });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/workbooks/${workbook.id}`,
      cookies: owner.cookies,
    });
    expect(del.statusCode).toBe(204);
    expect(del.body).toBe("");

    const after = await app.inject({
      method: "GET",
      url: `/api/workbooks/${workbook.id}`,
      cookies: owner.cookies,
    });
    expect(after.statusCode).toBe(404);
  });
});
