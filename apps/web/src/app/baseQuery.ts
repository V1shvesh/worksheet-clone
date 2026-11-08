import {
  fetchBaseQuery,
  retry,
  type BaseQueryFn,
  type FetchArgs,
} from "@reduxjs/toolkit/query/react";

/** Waits before retry 1, 2, 3, 4: 0.5, 1, 2, 4 seconds. */
export const RETRY_DELAYS_MS = [500, 1000, 2000, 4000] as const;
export const MAX_RETRIES = RETRY_DELAYS_MS.length;

/**
 * Only idempotent reads are retried automatically: replaying a POST/PATCH/DELETE
 * after a gateway error could apply it twice.
 */
export function isRetryableRequest(args: string | FetchArgs): boolean {
  return typeof args === "string" || (args.method ?? "GET").toUpperCase() === "GET";
}

/** What a server that is still starting (Railway wakes the container on the first request) or a flaky network returns. */
export function isTransientError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === "FETCH_ERROR" || status === 502 || status === 503 || status === 504;
}

export function shouldRetry(error: unknown, args: string | FetchArgs, attempt: number): boolean {
  return attempt <= MAX_RETRIES && isRetryableRequest(args) && isTransientError(error);
}

function backoff(attempt: number, _max: number, signal?: AbortSignal): Promise<void> {
  const delay = RETRY_DELAYS_MS[Math.min(attempt, MAX_RETRIES) - 1] ?? RETRY_DELAYS_MS[0];
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Aborted"));
    const timer = setTimeout(resolve, delay);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}

/** Wraps a base query so transient failures of idempotent requests are retried with backoff. */
export function withRetry<Q extends BaseQueryFn>(query: Q) {
  return retry(query, {
    retryCondition: (error, args, { attempt }) =>
      shouldRetry(error, args as string | FetchArgs, attempt),
    backoff,
  });
}

export const baseQuery = withRetry(fetchBaseQuery({ baseUrl: "/api", credentials: "include" }));
