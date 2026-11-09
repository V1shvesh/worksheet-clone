import type { IncomingMessage } from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import { DomainError } from "../domain/errors.js";
import { currentUser } from "./session.js";

export interface RateLimits {
  /** Requests per minute per IP for /api routes without a stricter limit of their own (health is exempt). */
  globalPerMinute: number;
  signupPerHour: number;
  loginPerMinute: number;
  /** Per signed-in user. */
  workbookCreatePerMinute: number;
  /** Per signed-in user. */
  memberAddPerMinute: number;
  /** WebSocket upgrade attempts per IP: a burst of this many, refilling at this many per minute. */
  wsUpgradePerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = {
  globalPerMinute: 300,
  signupPerHour: 5,
  loginPerMinute: 5,
  workbookCreatePerMinute: 30,
  memberAddPerMinute: 30,
  wsUpgradePerMinute: 60,
};

// What buildApp uses when NODE_ENV=test and a test passes nothing: the suites
// sign up dozens of users and open hundreds of sockets from 127.0.0.1 in one app.
// Login keeps its real value because an existing test asserts it. Tests of the
// real numbers pass DEFAULT_RATE_LIMITS (or their own values) explicitly.
export const TEST_RATE_LIMITS: RateLimits = {
  globalPerMinute: 1_000_000,
  signupPerHour: 1_000_000,
  loginPerMinute: DEFAULT_RATE_LIMITS.loginPerMinute,
  workbookCreatePerMinute: 1_000_000,
  memberAddPerMinute: 1_000_000,
  wsUpgradePerMinute: 1_000_000,
};

/**
 * In-memory token bucket per key: holds up to `capacity` tokens, refilled at
 * `refillPerMinute / 60` per second, one token per hit. State is per process,
 * which is right for a single instance; with several instances each would
 * allow its own budget. Idle keys are dropped when the map grows.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Takes a token. When refused, `retryAfterSeconds` says when one will be available. */
  take(key: string): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const now = this.now();
    const perMs = this.refillPerMinute / 60_000;
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (now - bucket.updatedAt) * perMs);
    bucket.updatedAt = now;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    this.sweep(now);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true };
    }
    return { allowed: false, retryAfterSeconds: Math.ceil((1 - bucket.tokens) / perMs / 1000) };
  }

  // Maps iterate in insertion order and take() re-inserts, so the first entries
  // are the least recently used; a full bucket carries no information.
  private sweep(now: number): void {
    if (this.buckets.size < 1_000) return;
    const perMs = this.refillPerMinute / 60_000;
    for (const [key, bucket] of this.buckets) {
      const refilled = bucket.tokens + (now - bucket.updatedAt) * perMs >= this.capacity;
      if (!refilled) break;
      this.buckets.delete(key);
    }
  }
}

/** A limiter per signed-in user, as a preHandler that must run after requireUser. */
export function perUserRateLimit(limiter: TokenBucketLimiter, what: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const result = limiter.take(currentUser(request).id);
    if (!result.allowed) {
      void reply.header("retry-after", String(result.retryAfterSeconds));
      throw new DomainError(
        "RATE_LIMITED",
        `Too many ${what}. Please wait a moment and try again.`,
      );
    }
  };
}

/**
 * The client address for requests that bypass Fastify (WebSocket upgrades),
 * mirroring Fastify's `trustProxy`: false uses the socket address; a number is
 * how many proxies sit in front (so the client is that many entries from the
 * right of X-Forwarded-For); true believes the leftmost entry, which a client
 * can forge, so prefer a hop count.
 */
export function clientAddress(request: IncomingMessage, trustProxy: boolean | number): string {
  const socketAddress = request.socket.remoteAddress ?? "unknown";
  if (trustProxy === false) return socketAddress;
  const header = request.headers["x-forwarded-for"];
  const forwarded = (Array.isArray(header) ? header.join(",") : (header ?? ""))
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (forwarded.length === 0) return socketAddress;
  if (trustProxy === true) return forwarded[0] ?? socketAddress;
  const chain = [...forwarded, socketAddress];
  return chain[Math.max(chain.length - 1 - trustProxy, 0)] ?? socketAddress;
}
