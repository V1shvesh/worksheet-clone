import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db, pool } from "../db/client.js";
import { createSession, deleteSession, getSessionUser, login, signup } from "./auth.js";
import { DomainError } from "./errors.js";

// A prefix unique to this file: other test files run against the same
// local Postgres instance concurrently, and an overlapping pattern here
// deleted their in-flight rows out from under them (see failure-log.md).
const EMAIL_PATTERN = "test-domain-auth-%@example.com";

async function uniqueEmail(): Promise<string> {
  return `test-domain-auth-${crypto.randomUUID()}@example.com`;
}

afterEach(async () => {
  await db.execute(
    sql`delete from sessions where user_id in (select id from users where email like ${EMAIL_PATTERN})`,
  );
  await db.execute(sql`delete from users where email like ${EMAIL_PATTERN}`);
});

afterAll(async () => {
  await pool.end();
});

beforeAll(async () => {
  await pool.query("select 1");
});

describe("signup", () => {
  it("creates a user with a hashed password", async () => {
    const email = await uniqueEmail();
    const user = await signup(email, "correct-password");
    expect(user.email).toBe(email);
    expect(user.id).toBeTruthy();
  });

  it("rejects a duplicate email", async () => {
    const email = await uniqueEmail();
    await signup(email, "correct-password");
    await expect(signup(email, "another-password")).rejects.toMatchObject(
      new DomainError("EMAIL_TAKEN", "An account with this email already exists"),
    );
  });
});

describe("login", () => {
  it("succeeds with the right password", async () => {
    const email = await uniqueEmail();
    await signup(email, "correct-password");
    const user = await login(email, "correct-password");
    expect(user.email).toBe(email);
  });

  it("rejects an unknown email", async () => {
    await expect(login("nobody@example.com", "whatever")).rejects.toMatchObject(
      new DomainError("INVALID_CREDENTIALS", "Invalid email or password"),
    );
  });

  it("rejects the wrong password", async () => {
    const email = await uniqueEmail();
    await signup(email, "correct-password");
    await expect(login(email, "wrong-password")).rejects.toMatchObject(
      new DomainError("INVALID_CREDENTIALS", "Invalid email or password"),
    );
  });
});

describe("sessions", () => {
  it("resolves the user for a valid session and not after deletion", async () => {
    const email = await uniqueEmail();
    const user = await signup(email, "correct-password");
    const session = await createSession(user.id);

    const resolved = await getSessionUser(session.id);
    expect(resolved).toEqual(user);

    await deleteSession(session.id);
    expect(await getSessionUser(session.id)).toBeNull();
  });

  it("returns null for an expired session", async () => {
    const email = await uniqueEmail();
    const user = await signup(email, "correct-password");
    const session = await createSession(user.id);
    await db.execute(
      sql`update sessions set expires_at = now() - interval '1 second' where id = ${session.id}`,
    );

    expect(await getSessionUser(session.id)).toBeNull();
  });
});
