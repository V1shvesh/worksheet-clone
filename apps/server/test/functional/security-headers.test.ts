import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { CONTENT_SECURITY_POLICY } from "../../src/http/security-headers.js";

const app = buildApp({ logStream: { write: () => undefined } });
const production = buildApp({ logStream: { write: () => undefined }, hsts: true });

afterAll(async () => {
  await app.close();
  await production.close();
});

function directives(csp: string | string[] | number | undefined): Map<string, string> {
  return new Map(
    String(csp)
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name = "", ...sources] = part.split(/\s+/);
        return [name, sources.join(" ")];
      }),
  );
}

describe("security headers", () => {
  it("ships the content security policy on API responses", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    const csp = directives(response.headers["content-security-policy"]);
    expect(Object.fromEntries(csp)).toEqual({
      "default-src": "'self'",
      "script-src": "'self'",
      "script-src-attr": "'none'",
      "style-src": "'self' 'unsafe-inline'",
      "img-src": "'self' data:",
      "font-src": "'self' data:",
      "connect-src": "'self'",
      "frame-ancestors": "'none'",
      "object-src": "'none'",
      "base-uri": "'self'",
      "form-action": "'self'",
    });
    expect(Object.keys(CONTENT_SECURITY_POLICY)).toHaveLength(csp.size);
  });

  it("never allows inline or eval'd scripts", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    const csp = directives(response.headers["content-security-policy"]);
    expect(csp.get("script-src")).not.toMatch(/unsafe-/);
    expect(csp.get("default-src")).not.toMatch(/unsafe-/);
  });

  it("adds the other hardening headers", async () => {
    const response = await app.inject({ method: "GET", url: "/api/health" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["referrer-policy"]).toBe("same-origin");
    expect(response.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("also covers error and not-found responses", async () => {
    for (const url of ["/api/auth/me", "/api/nope", "/not-an-api-path"]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.headers["content-security-policy"], url).toContain("frame-ancestors 'none'");
    }
  });

  it("sends HSTS only when enabled (production)", async () => {
    const dev = await app.inject({ method: "GET", url: "/api/health" });
    expect(dev.headers["strict-transport-security"]).toBeUndefined();
    const prod = await production.inject({ method: "GET", url: "/api/health" });
    expect(prod.headers["strict-transport-security"]).toBe("max-age=15552000; includeSubDomains");
  });
});
