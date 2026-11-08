import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import { createWorkbook } from "../../src/domain/workbooks.js";
import { describeDbError } from "../../src/logging.js";
import { connectCollab, waitFor } from "../helpers/collab.js";
import { cleanupByEmailPattern, testEmails } from "../helpers/db.js";
import { signupClient } from "../helpers/http.js";

const emails = testEmails("test-logging");
const lines: string[] = [];
let app: FastifyInstance;
let baseUrl: string;

beforeAll(async () => {
  app = buildApp({ logStream: { write: (message) => void lines.push(message) } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});
afterAll(async () => {
  await app.close();
  await cleanupByEmailPattern(emails.pattern);
  await pool.end();
});

const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);

describe("describeDbError (and the err serializer)", () => {
  it("never includes the query parameters (the document bytes)", () => {
    const drizzle = Object.assign(
      new Error('Failed query: insert into "yjs_documents"\nparams: secret-cell-content'),
      {
        cause: Object.assign(new Error('relation "yjs_documents" does not exist'), {
          code: "42P01",
        }),
      },
    );
    const described = describeDbError(drizzle);
    expect(described).toEqual({
      name: "Error",
      code: "42P01",
      reason: 'relation "yjs_documents" does not exist',
    });
    expect(JSON.stringify(describeDbError(new Error("a\nsecret")))).not.toContain("secret");
  });
});

describe("log redaction", () => {
  it("reduces a logged Drizzle query error to the driver cause (no query parameters)", () => {
    const drizzle = Object.assign(
      new Error('Failed query: select from "sessions"\nparams: SESSION-ID-IN-PARAMS'),
      {
        query: 'select from "sessions"',
        params: ["SESSION-ID-IN-PARAMS"],
        cause: Object.assign(new Error("connection terminated"), { code: "08006" }),
      },
    );
    app.log.error({ err: drizzle }, "serializer probe");
    const record = records().find((r) => r.msg === "serializer probe");
    expect(record?.err).toMatchObject({ message: "connection terminated", code: "08006" });
    expect(JSON.stringify(record)).not.toContain("SESSION-ID-IN-PARAMS");
  });

  it("redacts cookie and set-cookie headers wherever they are logged", () => {
    app.log.info(
      {
        req: { headers: { cookie: "session=REQ-COOKIE-SECRET" } },
        res: { headers: { "set-cookie": "session=SET-COOKIE-SECRET" } },
        headers: { cookie: "session=BARE-HEADERS-SECRET" },
      },
      "redaction probe",
    );
    const text = lines.join("");
    expect(text).toContain("redaction probe");
    expect(text).toContain("[Redacted]");
    for (const secret of ["REQ-COOKIE-SECRET", "SET-COOKIE-SECRET", "BARE-HEADERS-SECRET"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("never logs the session cookie or session id across REST and collab auth, and tags decisions with workbookId/userId", async () => {
    const owner = await signupClient(app, emails.next());
    const stranger = await signupClient(app, emails.next());
    const workbook = await createWorkbook(owner.id, "Logged");
    const sessionCookie = (user: { cookies: Record<string, string> }) => user.cookies.session ?? "";

    const allowed = connectCollab({
      baseUrl,
      workbookId: workbook.id,
      cookie: `session=${sessionCookie(owner)}`,
    });
    expect((await allowed.outcome).kind).toBe("synced");
    const refused = connectCollab({
      baseUrl,
      workbookId: workbook.id,
      cookie: `session=${sessionCookie(stranger)}`,
    });
    expect((await refused.outcome).kind).toBe("denied");
    await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: `session=${sessionCookie(owner)}` },
    });
    allowed.destroy();
    refused.destroy();
    await waitFor(() => app.collab.getDocumentsCount() === 0);

    const text = lines.join("");
    for (const user of [owner, stranger]) {
      const signed = sessionCookie(user);
      const sessionId = app.unsignCookie(signed).value ?? "";
      expect(sessionId).not.toBe("");
      expect(text).not.toContain(signed);
      expect(text).not.toContain(sessionId);
      expect(text).not.toContain(decodeURIComponent(signed));
    }

    const find = (msg: string) => records().filter((record) => record.msg === msg);
    expect(find("collab connection authorized")).toContainEqual(
      expect.objectContaining({ workbookId: workbook.id, userId: owner.id, role: "owner" }),
    );
    expect(find("collab connection refused")).toContainEqual(
      expect.objectContaining({ workbookId: workbook.id, userId: stranger.id }),
    );
    expect(find("workbook document unloaded")).toContainEqual(
      expect.objectContaining({ workbookId: workbook.id }),
    );
  });
});
