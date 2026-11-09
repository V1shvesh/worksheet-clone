import type { IncomingMessage } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../../src/app.js";
import { pool } from "../../src/db/client.js";
import {
  clientAddress,
  DEFAULT_RATE_LIMITS,
  TokenBucketLimiter,
} from "../../src/http/rate-limits.js";
import { cleanupByEmailPattern, testEmails } from "../helpers/db.js";
import { signupClient } from "../helpers/http.js";

const emails = testEmails("test-ratelimit");
const quiet = { write: () => undefined };
// Where users are created (limits relaxed), as opposed to the app under test.
const loose = buildApp({ logStream: quiet });
const strict = buildApp({
  logStream: quiet,
  rateLimits: {
    globalPerMinute: 10_000,
    signupPerHour: 2,
    workbookCreatePerMinute: 2,
    memberAddPerMinute: 2,
    wsUpgradePerMinute: 3,
  },
});

afterEach(async () => {
  await cleanupByEmailPattern(emails.pattern);
});
afterAll(async () => {
  await loose.close();
  await strict.close();
  await pool.end();
});

const json = { "content-type": "application/json" };

describe("TokenBucketLimiter", () => {
  it("allows a burst, then refills over time and reports when", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(3, 60, () => now); // 1 token per second
    expect([1, 2, 3].map(() => limiter.take("a").allowed)).toEqual([true, true, true]);
    expect(limiter.take("a")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    expect(limiter.take("b").allowed).toBe(true);
    now = 1_000;
    expect(limiter.take("a").allowed).toBe(true);
    expect(limiter.take("a").allowed).toBe(false);
    now = 10_000;
    expect([1, 2, 3].map(() => limiter.take("a").allowed)).toEqual([true, true, true]);
    expect(limiter.take("a").allowed).toBe(false);
  });
});

describe("clientAddress", () => {
  const request = (forwarded: string | undefined, remote = "10.0.0.1") =>
    ({
      socket: { remoteAddress: remote },
      headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
    }) as unknown as IncomingMessage;

  it("ignores X-Forwarded-For unless a proxy is trusted", () => {
    expect(clientAddress(request("1.2.3.4"), false)).toBe("10.0.0.1");
  });
  it("counts hops from the right, so a forged leftmost entry is ignored", () => {
    expect(clientAddress(request("6.6.6.6, 1.2.3.4"), 1)).toBe("1.2.3.4");
    expect(clientAddress(request("1.2.3.4"), 1)).toBe("1.2.3.4");
    expect(clientAddress(request("6.6.6.6, 1.2.3.4"), 2)).toBe("6.6.6.6");
    expect(clientAddress(request(undefined), 1)).toBe("10.0.0.1");
  });
  it("true believes the leftmost entry", () => {
    expect(clientAddress(request("6.6.6.6, 1.2.3.4"), true)).toBe("6.6.6.6");
  });
});

describe("rate limits", () => {
  it("ships the documented defaults", () => {
    expect(DEFAULT_RATE_LIMITS).toEqual({
      globalPerMinute: 300,
      signupPerHour: 5,
      loginPerMinute: 5,
      workbookCreatePerMinute: 30,
      memberAddPerMinute: 30,
      wsUpgradePerMinute: 60,
    });
  });

  it("limits /api per IP with our error shape, and exempts health", async () => {
    const app = buildApp({ logStream: quiet, rateLimits: { globalPerMinute: 3 } });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
    const limited = await app.inject({ method: "GET", url: "/api/auth/me" });
    expect(limited.json()).toEqual({
      error: { code: "RATE_LIMITED", message: "Too many attempts. Please wait and try again." },
    });
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);

    for (let i = 0; i < 20; i++) {
      expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    }
    await app.close();
  });

  it("limits signups per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await strict.inject({
        method: "POST",
        url: "/api/auth/signup",
        headers: json,
        payload: { email: emails.next(), password: "correct-password" },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([201, 201, 429]);
  });

  it("limits workbook creation per user, not per IP", async () => {
    const alice = await signupClient(loose, emails.next());
    const bob = await signupClient(loose, emails.next());
    const create = (user: typeof alice) =>
      strict.inject({
        method: "POST",
        url: "/api/workbooks",
        headers: json,
        cookies: user.cookies,
        payload: { name: "W" },
      });
    expect([(await create(alice)).statusCode, (await create(alice)).statusCode]).toEqual([
      201, 201,
    ]);
    const refused = await create(alice);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe("RATE_LIMITED");
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    // Same IP, different user: unaffected.
    expect((await create(bob)).statusCode).toBe(201);
  });

  it("limits adding members per user", async () => {
    const owner = await signupClient(loose, emails.next());
    const created = await loose.inject({
      method: "POST",
      url: "/api/workbooks",
      headers: json,
      cookies: owner.cookies,
      payload: { name: "Shared" },
    });
    const id = created.json().workbook.id as string;
    const add = () =>
      strict.inject({
        method: "POST",
        url: `/api/workbooks/${id}/members`,
        headers: json,
        cookies: owner.cookies,
        payload: { email: "nobody@example.com", role: "viewer" },
      });
    expect([(await add()).statusCode, (await add()).statusCode]).toEqual([404, 404]);
    expect((await add()).statusCode).toBe(429);
  });

  it("keys on the socket address unless TRUST_PROXY is set", async () => {
    const get = (app: ReturnType<typeof buildApp>, forwarded: string) =>
      app.inject({
        method: "GET",
        url: "/api/auth/me",
        remoteAddress: "10.0.0.9",
        headers: { "x-forwarded-for": forwarded },
      });
    const untrusting = buildApp({ logStream: quiet, rateLimits: { globalPerMinute: 2 } });
    const spoofed = [
      await get(untrusting, "1.1.1.1"),
      await get(untrusting, "2.2.2.2"),
      await get(untrusting, "3.3.3.3"),
    ];
    expect(spoofed.map((r) => r.statusCode)).toEqual([401, 401, 429]);

    const behindProxy = buildApp({
      logStream: quiet,
      rateLimits: { globalPerMinute: 2 },
      trustProxy: 1,
    });
    const real = [
      await get(behindProxy, "9.9.9.9, 1.1.1.1"),
      await get(behindProxy, "9.9.9.9, 1.1.1.1"),
      await get(behindProxy, "9.9.9.9, 1.1.1.1"),
      await get(behindProxy, "9.9.9.9, 2.2.2.2"),
    ];
    expect(real.map((r) => r.statusCode)).toEqual([401, 401, 429, 401]);
    await untrusting.close();
    await behindProxy.close();
  });
});

describe("WebSocket upgrade limit", () => {
  let baseUrl: string;
  beforeAll(async () => {
    await strict.listen({ port: 0, host: "127.0.0.1" });
    const address = strict.server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });

  it("answers 429 with Retry-After once an IP exceeds its burst", async () => {
    const attempt = () =>
      new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/collab`, {
          headers: { origin: baseUrl },
        });
        socket.on("open", () => {
          socket.close();
          resolve(101);
        });
        socket.on("unexpected-response", (_request, response) => {
          if (response.statusCode === 429) {
            expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
          }
          resolve(response.statusCode ?? 0);
        });
        socket.on("error", reject);
      });
    const results: number[] = [];
    for (let i = 0; i < 5; i++) results.push(await attempt());
    expect(results).toEqual([101, 101, 101, 429, 429]);
  });
});
