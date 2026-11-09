import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./auth.js";
import { registerMemberRoutes } from "./members.js";
import { TokenBucketLimiter, type RateLimits } from "./rate-limits.js";
import { registerWorkbookRoutes } from "./workbooks.js";

/**
 * The /api routes behind the rate limits. Everything is defined inside this
 * plugin so `await api.register(rateLimit, ...)` finishes booting the plugin's
 * `onRoute` hook before any route is added: registered bare, the registration is
 * deferred and routes added synchronously after it would miss the hook
 * (docs/failure-log.md). Routes with their own `config.rateLimit` (signup, login) have
 * separate, stricter counters and are not counted against the global one; the
 * health route is registered outside this scope and is exempt.
 */
export function registerApiRoutes(app: FastifyInstance, limits: RateLimits): void {
  void app.register(async (api) => {
    await api.register(rateLimit, {
      global: true,
      max: limits.globalPerMinute,
      timeWindow: "1 minute",
    });
    registerAuthRoutes(api, limits);
    registerWorkbookRoutes(
      api,
      new TokenBucketLimiter(limits.workbookCreatePerMinute, limits.workbookCreatePerMinute),
    );
    registerMemberRoutes(
      api,
      new TokenBucketLimiter(limits.memberAddPerMinute, limits.memberAddPerMinute),
    );
  });
}
