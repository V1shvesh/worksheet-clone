import { afterAll, afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { SESSION_COOKIE_NAME } from "../../src/http/session.js";

const EMAIL_PATTERN = "test-auth-%@example.com";

afterEach(async () => {
  await db.execute(
    sql`delete from sessions where user_id in (select id from users where email like ${EMAIL_PATTERN})`,
  );
  await db.execute(sql`delete from users where email like ${EMAIL_PATTERN}`);
});

afterAll(async () => {
  await pool.end();
});

function uniqueEmail(): string {
  return `test-auth-${crypto.randomUUID()}@example.com`;
}

function extractRawCookie(setCookieHeader: string | string[] | undefined): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ""];
  const match = headers[0]?.match(new RegExp(`^${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!match?.[1]) {
    throw new Error("session cookie not found in Set-Cookie header");
  }
  return match[1];
}

describe("POST /api/auth/signup", () => {
  it("creates a user, sets a session cookie, and returns the user", async () => {
    const app = buildApp();
    const email = uniqueEmail();

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "correct-password" },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ user: { email } });
    expect(response.headers["set-cookie"]).toBeDefined();
  });

  it("rejects a duplicate email with 409", async () => {
    const app = buildApp();
    const email = uniqueEmail();
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "correct-password" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "another-password" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "EMAIL_TAKEN" } });
  });

  it("rejects an invalid payload with 400", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "not-an-email", password: "short" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });
});

describe("POST /api/auth/login", () => {
  it("logs in with the right password", async () => {
    const app = buildApp();
    const email = uniqueEmail();
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "correct-password" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "correct-password" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { email } });
  });

  it("rejects the wrong password with 401", async () => {
    const app = buildApp();
    const email = uniqueEmail();
    await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "correct-password" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email, password: "wrong-password" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_CREDENTIALS" } });
  });

  it("rate-limits repeated attempts", async () => {
    const app = buildApp();
    const email = uniqueEmail();

    let lastResponse;
    for (let i = 0; i < 6; i++) {
      lastResponse = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email, password: "wrong-password" },
      });
    }

    expect(lastResponse?.statusCode).toBe(429);
  });
});

describe("GET /api/auth/me + POST /api/auth/logout", () => {
  it("returns the current user when logged in, then 401s after logout", async () => {
    const app = buildApp();
    const email = uniqueEmail();

    const signupResponse = await app.inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email, password: "correct-password" },
    });
    const cookieValue = extractRawCookie(signupResponse.headers["set-cookie"]);

    const meResponse = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { [SESSION_COOKIE_NAME]: cookieValue },
    });
    expect(meResponse.statusCode).toBe(200);
    expect(meResponse.json()).toMatchObject({ user: { email } });

    await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      cookies: { [SESSION_COOKIE_NAME]: cookieValue },
    });

    const afterLogout = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      cookies: { [SESSION_COOKIE_NAME]: cookieValue },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("returns 401 for /me with no session", async () => {
    const app = buildApp();
    const response = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(response.statusCode).toBe(401);
  });
});
