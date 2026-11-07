import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpUser, startStack, type Stack } from "./stack.js";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 60_000);

afterAll(() => stack?.stop());

describe("signup -> me (real server, real Postgres via Testcontainers)", () => {
  it("lets a real HTTP client sign up and then fetch /me using the session cookie", async () => {
    const user = new HttpUser(stack, "e2e-signup-to-me@example.com");
    await user.signup();

    const me = await user.request("GET", "/api/auth/me");
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(user.email);

    const anonymous = await fetch(`${stack.baseUrl}/api/auth/me`);
    expect(anonymous.status).toBe(401);
  });
});
