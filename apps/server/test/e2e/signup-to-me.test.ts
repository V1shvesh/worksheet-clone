import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";

let container: StartedPostgreSqlContainer;
let server: FastifyInstance;
let pool: Pool;
let baseUrl: string;

function extractRawCookie(setCookieHeader: string | null): string {
  const match = setCookieHeader?.match(/^session=([^;]+)/);
  if (!match?.[1]) {
    throw new Error("session cookie not found in Set-Cookie header");
  }
  return `session=${match[1]}`;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine")
    .withDatabase("worksheet")
    .withUsername("worksheet")
    .withPassword("worksheet")
    .start();

  // These modules read DATABASE_URL at import time, so the env var must be
  // set before the first (dynamic) import of anything that touches db/client.
  process.env.DATABASE_URL = container.getConnectionUri();

  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const client = await import("../../src/db/client.js");
  pool = client.pool;
  await migrate(client.db, { migrationsFolder: "./src/db/migrations" });

  const { buildApp } = await import("../../src/app.js");
  server = buildApp();
  await server.listen({ port: 0, host: "127.0.0.1" });
  const address = server.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}, 60_000);

afterAll(async () => {
  await server?.close();
  await pool?.end();
  await container?.stop();
});

describe("signup -> me (real server, real Postgres via Testcontainers)", () => {
  it("lets a real HTTP client sign up and then fetch /me using the session cookie", async () => {
    const email = "e2e-signup-to-me@example.com";

    const signupResponse = await fetch(`${baseUrl}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-password" }),
    });
    expect(signupResponse.status).toBe(201);
    const cookie = extractRawCookie(signupResponse.headers.get("set-cookie"));

    const meResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { cookie },
    });
    expect(meResponse.status).toBe(200);
    const body = (await meResponse.json()) as { user: { email: string } };
    expect(body.user.email).toBe(email);

    const noCookieResponse = await fetch(`${baseUrl}/api/auth/me`);
    expect(noCookieResponse.status).toBe(401);
  });
});
