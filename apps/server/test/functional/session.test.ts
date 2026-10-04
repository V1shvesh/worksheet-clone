import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { createSession, signup } from "../../src/domain/auth.js";
import { requireUser, setSessionCookie, SESSION_COOKIE_NAME } from "../../src/http/session.js";

function buildTestApp() {
  const app = buildApp();
  app.get("/api/test/login-as/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    setSessionCookie(reply, sessionId);
    return { ok: true };
  });
  app.get("/api/test/protected", { preHandler: requireUser }, async (request) => ({
    user: request.user,
  }));
  return app;
}

function extractRawCookie(setCookieHeader: string | string[] | undefined): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ""];
  const match = headers[0]?.match(new RegExp(`^${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!match?.[1]) {
    throw new Error("session cookie not found in Set-Cookie header");
  }
  return match[1];
}

const EMAIL_PATTERN = "test-session-%@example.com";

afterEach(async () => {
  await db.execute(
    sql`delete from sessions where user_id in (select id from users where email like ${EMAIL_PATTERN})`,
  );
  await db.execute(sql`delete from users where email like ${EMAIL_PATTERN}`);
});

afterAll(async () => {
  await pool.end();
});

describe("requireUser", () => {
  it("rejects a request with no session cookie", async () => {
    const app = buildTestApp();
    const response = await app.inject({ method: "GET", url: "/api/test/protected" });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a forged cookie", async () => {
    const app = buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/test/protected",
      cookies: { [SESSION_COOKIE_NAME]: "forged-value" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("attaches the user for a valid session cookie", async () => {
    const app = buildTestApp();
    const email = `test-session-${crypto.randomUUID()}@example.com`;
    const user = await signup(email, "correct-password");
    const session = await createSession(user.id);

    const loginResponse = await app.inject({
      method: "GET",
      url: `/api/test/login-as/${session.id}`,
    });
    const cookieValue = extractRawCookie(loginResponse.headers["set-cookie"]);

    const response = await app.inject({
      method: "GET",
      url: "/api/test/protected",
      cookies: { [SESSION_COOKIE_NAME]: cookieValue },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user });
  });
});
