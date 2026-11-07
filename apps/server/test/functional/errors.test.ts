import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";

afterAll(() => pool.end());

describe("error responses all use the { error: { code, message } } shape", () => {
  it("maps malformed JSON to VALIDATION_ERROR", async () => {
    const response = await buildApp().inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: "{oops",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("names the failing field in validation messages", async () => {
    const response = await buildApp().inject({
      method: "POST",
      url: "/api/auth/signup",
      payload: { email: "not-an-email", password: "longenough" },
    });
    expect(response.json().error.message).toMatch(/^email: /);
  });

  it("maps unknown /api routes to NOT_FOUND", async () => {
    const response = await buildApp().inject({ method: "GET", url: "/api/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: { code: "NOT_FOUND", message: "Not found" } });
  });

  it("maps rate limiting to RATE_LIMITED", async () => {
    const app = buildApp();
    let last;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email: "test-errors-nobody@example.com", password: "wrong-password" },
      });
    }
    expect(last?.statusCode).toBe(429);
    expect(last?.json()).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });

  it("hides internal error details behind INTERNAL_ERROR", async () => {
    const app = buildApp();
    app.get("/api/test/boom", async () => {
      throw new Error("secret db detail");
    });

    const response = await app.inject({ method: "GET", url: "/api/test/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Something went wrong" },
    });
  });
});
