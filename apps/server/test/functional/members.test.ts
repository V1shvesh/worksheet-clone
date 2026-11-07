import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { cleanupByEmailPattern, testEmails } from "../helpers/db.js";
import { signupClient, type TestClient } from "../helpers/http.js";

const emails = testEmails("test-http-mem");
let app: FastifyInstance;

beforeEach(() => {
  app = buildApp();
});
afterEach(() => cleanupByEmailPattern(emails.pattern));
afterAll(() => pool.end());

async function setup() {
  const owner = await signupClient(app, emails.next());
  const editor = await signupClient(app, emails.next());
  const viewer = await signupClient(app, emails.next());
  const created = await app.inject({
    method: "POST",
    url: "/api/workbooks",
    cookies: owner.cookies,
    payload: { name: "Team" },
  });
  const workbookId = created.json().workbook.id as string;
  for (const [client, role] of [
    [editor, "editor"],
    [viewer, "viewer"],
  ] as const) {
    const added = await add(owner, workbookId, client.email, role);
    expect(added.statusCode).toBe(201);
  }
  return { owner, editor, viewer, workbookId };
}

function add(actor: TestClient, workbookId: string, email: string, role: string) {
  return app.inject({
    method: "POST",
    url: `/api/workbooks/${workbookId}/members`,
    cookies: actor.cookies,
    payload: { email, role },
  });
}

describe("/api/workbooks/:id/members", () => {
  it("lists members for every role, owner first", async () => {
    const { owner, editor, viewer, workbookId } = await setup();

    for (const client of [owner, editor, viewer]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/workbooks/${workbookId}/members`,
        cookies: client.cookies,
      });
      expect(response.statusCode).toBe(200);
      const members = response.json().members as { email: string; role: string }[];
      expect(members[0]).toMatchObject({ email: owner.email, role: "owner" });
      expect(members).toHaveLength(3);
    }
  });

  it("forbids editors and viewers from managing members", async () => {
    const { owner, editor, viewer, workbookId } = await setup();
    const newcomer = await signupClient(app, emails.next());

    for (const actor of [editor, viewer]) {
      const responses = [
        await add(actor, workbookId, newcomer.email, "viewer"),
        await app.inject({
          method: "PATCH",
          url: `/api/workbooks/${workbookId}/members/${viewer.id}`,
          cookies: actor.cookies,
          payload: { role: "editor" },
        }),
        await app.inject({
          method: "DELETE",
          url: `/api/workbooks/${workbookId}/members/${owner.id}`,
          cookies: actor.cookies,
        }),
      ];
      for (const response of responses) {
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
      }
    }
  });

  it("maps add-member failures to their codes", async () => {
    const { owner, viewer, workbookId } = await setup();

    const unknown = await add(owner, workbookId, "test-http-mem-ghost@example.com", "viewer");
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: "USER_NOT_FOUND" } });

    const duplicate = await add(owner, workbookId, viewer.email, "editor");
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ error: { code: "ALREADY_MEMBER" } });

    const asOwner = await add(owner, workbookId, viewer.email, "owner");
    expect(asOwner.statusCode).toBe(400);
    expect(asOwner.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("changes a role and removes a member as owner", async () => {
    const { owner, viewer, workbookId } = await setup();

    const promoted = await app.inject({
      method: "PATCH",
      url: `/api/workbooks/${workbookId}/members/${viewer.id}`,
      cookies: owner.cookies,
      payload: { role: "editor" },
    });
    expect(promoted.json().member).toMatchObject({ userId: viewer.id, role: "editor" });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/workbooks/${workbookId}/members/${viewer.id}`,
      cookies: owner.cookies,
    });
    expect(removed.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/api/workbooks",
      cookies: viewer.cookies,
    });
    expect(list.json().workbooks).toEqual([]);
  });

  it("refuses to demote or remove the owner", async () => {
    const { owner, workbookId } = await setup();

    const demote = await app.inject({
      method: "PATCH",
      url: `/api/workbooks/${workbookId}/members/${owner.id}`,
      cookies: owner.cookies,
      payload: { role: "viewer" },
    });
    const remove = await app.inject({
      method: "DELETE",
      url: `/api/workbooks/${workbookId}/members/${owner.id}`,
      cookies: owner.cookies,
    });
    for (const response of [demote, remove]) {
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: { code: "INVALID_MEMBER_OPERATION" } });
    }
  });

  it("returns 404 to non-members and for malformed ids", async () => {
    const { workbookId } = await setup();
    const stranger = await signupClient(app, emails.next());

    for (const url of [
      `/api/workbooks/${workbookId}/members`,
      "/api/workbooks/not-a-uuid/members",
    ]) {
      const response = await app.inject({ method: "GET", url, cookies: stranger.cookies });
      expect(response.statusCode, url).toBe(404);
    }
  });
});
