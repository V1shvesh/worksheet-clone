import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseQueryApi, BaseQueryFn, FetchArgs } from "@reduxjs/toolkit/query";
import {
  MAX_RETRIES,
  RETRY_DELAYS_MS,
  isTransientError,
  shouldRetry,
  withRetry,
} from "./baseQuery";

// A plain object instead of AbortSignal: RTK Query under jsdom trips over jsdom's AbortController
// (see docs/failure-log.md), and the retry wrapper only reads `aborted` and listens for "abort".
const api = {
  signal: { aborted: false, addEventListener: () => undefined },
} as unknown as BaseQueryApi;

type Reply = { error: { status: number | string } } | { data: string };
function stub(...replies: Reply[]) {
  const calls: (string | FetchArgs)[] = [];
  const query = vi.fn(async (args: string | FetchArgs) => {
    calls.push(args);
    return replies[Math.min(calls.length, replies.length) - 1]!;
  });
  return { query, calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("transient error rules", () => {
  it("retries gateway errors and network failures only", () => {
    for (const status of [502, 503, 504, "FETCH_ERROR"]) {
      expect(isTransientError({ status })).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 429, 500, "PARSING_ERROR"]) {
      expect(isTransientError({ status })).toBe(false);
    }
  });

  it("never retries non-idempotent requests, and stops after the last attempt", () => {
    const down = { status: 503 };
    expect(shouldRetry(down, "/workbooks", 1)).toBe(true);
    expect(shouldRetry(down, { url: "/x", method: "get" }, 1)).toBe(true);
    expect(shouldRetry(down, { url: "/x", method: "POST" }, 1)).toBe(false);
    expect(shouldRetry(down, { url: "/x", method: "PATCH" }, 1)).toBe(false);
    expect(shouldRetry(down, { url: "/x", method: "DELETE" }, 1)).toBe(false);
    expect(shouldRetry(down, "/workbooks", MAX_RETRIES)).toBe(true);
    expect(shouldRetry(down, "/workbooks", MAX_RETRIES + 1)).toBe(false);
  });
});

describe("withRetry", () => {
  const run = (query: ReturnType<typeof stub>["query"], args: string | FetchArgs) =>
    withRetry(query as unknown as BaseQueryFn)(args, api, {}) as Promise<unknown>;

  it("retries a GET through 503s with 0.5 s, 1 s backoff, then returns the data", async () => {
    const { query } = stub({ error: { status: 503 } }, { error: { status: 503 } }, { data: "ok" });
    const result = run(query, "/auth/me");
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[0] - 1);
    expect(query).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(query).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS[1]);
    expect(await result).toEqual({ data: "ok" });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("gives up after four retries and returns the last error", async () => {
    const { query } = stub({ error: { status: 504 } });
    const result = run(query, "/workbooks");
    await vi.advanceTimersByTimeAsync(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
    expect(await result).toEqual({ error: { status: 504 } });
    expect(query).toHaveBeenCalledTimes(1 + MAX_RETRIES);
  });

  it("does not retry a POST, nor a GET that fails for a real reason", async () => {
    const post = stub({ error: { status: 503 } });
    expect(await run(post.query, { url: "/workbooks", method: "POST" })).toEqual({
      error: { status: 503 },
    });
    expect(post.query).toHaveBeenCalledTimes(1);

    const forbidden = stub({ error: { status: 403 } });
    expect(await run(forbidden.query, "/workbooks/1")).toEqual({ error: { status: 403 } });
    expect(forbidden.query).toHaveBeenCalledTimes(1);
  });
});
