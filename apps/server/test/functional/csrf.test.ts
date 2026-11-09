import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";

const app = buildApp({ logStream: { write: () => undefined } });
afterAll(async () => {
  await app.close();
});

const HOST = "worksheet.example.com";
const json = { "content-type": "application/json", host: HOST };
const bad = JSON.stringify({ email: "not-an-email", password: "x" });

async function post(headers: Record<string, string>, payload?: string, url = "/api/auth/login") {
  return app.inject({ method: "POST", url, headers, payload });
}

describe("CSRF defence on /api", () => {
  it("lets a same-origin JSON request through (reaches validation)", async () => {
    const response = await post({ ...json, origin: `https://${HOST}` }, bad);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("lets a request without an Origin header through (curl, tests, servers)", async () => {
    expect((await post(json, bad)).statusCode).toBe(400);
  });

  it("refuses a cross-origin request with FORBIDDEN", async () => {
    const response = await post({ ...json, origin: "https://evil.example" }, bad);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Cross-origin request refused" },
    });
  });

  it("refuses a matching host on another port or scheme-less/null origins", async () => {
    expect((await post({ ...json, origin: `https://${HOST}:8443` }, bad)).statusCode).toBe(403);
    expect((await post({ ...json, origin: "null" }, bad)).statusCode).toBe(403);
    expect((await post({ ...json, origin: "garbage" }, bad)).statusCode).toBe(403);
  });

  it("checks the Origin on PUT, PATCH and DELETE as well", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: "/api/workbooks/x",
        headers: { host: HOST, origin: "https://evil.example" },
      });
      expect(response.statusCode, method).toBe(403);
    }
  });

  it("does not check Origin on safe methods", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: HOST, origin: "https://evil.example" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("answers 415 for form encodings a cross-site <form> can send", async () => {
    for (const type of [
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "text/plain",
    ]) {
      const response = await post({ "content-type": type, host: HOST }, "email=a&password=b");
      expect(response.statusCode, type).toBe(415);
      expect(response.json().error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
  });

  it("answers 415 for a form-typed request even with an empty body", async () => {
    const response = await post({
      "content-type": "application/x-www-form-urlencoded",
      host: HOST,
    });
    expect(response.statusCode).toBe(415);
  });

  it("answers 415 for a body with no Content-Type", async () => {
    const response = await post({ host: HOST }, bad);
    expect(response.statusCode).toBe(415);
  });

  it("accepts a body-less request without a Content-Type (what the web app sends for logout/delete)", async () => {
    const response = await post(
      { host: HOST, origin: `https://${HOST}` },
      undefined,
      "/api/auth/logout",
    );
    expect(response.statusCode).toBe(200);
  });

  it("accepts application/json with a charset", async () => {
    const response = await post(
      { "content-type": "application/json; charset=utf-8", host: HOST },
      bad,
    );
    expect(response.statusCode).toBe(400);
  });

  it("is checked before authentication and body parsing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/workbooks",
      headers: { "content-type": "application/json", host: HOST, origin: "https://evil.example" },
      payload: "{not json",
    });
    expect(response.statusCode).toBe(403);
  });
});
