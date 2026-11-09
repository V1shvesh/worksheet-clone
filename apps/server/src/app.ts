import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { config } from "./config.js";
import { setPoolErrorLogger } from "./db/client.js";
import { registerApiRoutes } from "./http/api.js";
import { registerCsrfProtection } from "./http/csrf.js";
import { registerErrorHandler, sendApiError } from "./http/errors.js";
import { registerHealthRoute } from "./http/health.js";
import { DEFAULT_RATE_LIMITS, TEST_RATE_LIMITS, type RateLimits } from "./http/rate-limits.js";
import { registerSecurityHeaders } from "./http/security-headers.js";
import { registerSessionPlugin } from "./http/session.js";
import { LIMITS, type Limits } from "@worksheet-clone/shared";
import { docSizeLimitExtension } from "./realtime/doc-size-limit.js";
import { awarenessIdentityExtension } from "./realtime/awareness.js";
import { buildLoggerOptions } from "./logging.js";
import { mountCollab } from "./realtime/collab.js";
import { sheetRenameNoticeExtension } from "./realtime/notices.js";
import { persistenceExtension, type PersistenceOptions } from "./realtime/persistence.js";

// In the monorepo (and the pre-pack Docker build stage), apps/web/dist sits
// two levels up from this file. The final Docker runtime stage copies that
// directory to a fixed location and points WEB_DIST_DIR at it instead,
// since it doesn't keep the monorepo's directory layout.
const webDistDir = config.webDistDir ?? fileURLToPath(new URL("../../web/dist", import.meta.url));

export interface BuildAppOptions {
  /** Test seams (failing store, short retry delays); production passes none. */
  persistence?: PersistenceOptions;
  /** Test seam: capture log lines (default: stdout). */
  logStream?: { write(message: string): void };
  /** Send Strict-Transport-Security (default: only in production). */
  hsts?: boolean;
  /** Test seam: override the size limits (defaults: LIMITS from shared). */
  limits?: Partial<Limits>;
  /** Override the rate limits (default: DEFAULT_RATE_LIMITS; relaxed under NODE_ENV=test). */
  rateLimits?: Partial<RateLimits>;
  /** Override TRUST_PROXY (Fastify's trustProxy: believe X-Forwarded-For for request.ip). */
  trustProxy?: boolean | number;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const limits: Limits = { ...LIMITS, ...options.limits };
  const rateLimits: RateLimits = {
    ...(config.nodeEnv === "test" ? TEST_RATE_LIMITS : DEFAULT_RATE_LIMITS),
    ...options.rateLimits,
  };
  const trustProxy = options.trustProxy ?? config.trustProxy;
  const app = Fastify({
    logger: buildLoggerOptions(options.logStream),
    bodyLimit: limits.restBodyBytes,
    // Fastify's types only list the boolean/function forms; a hop count is the
    // function "trust the first N hops from the socket" (what proxy-addr does for a number).
    trustProxy:
      typeof trustProxy === "number"
        ? (_address: string, hop: number) => hop < trustProxy
        : trustProxy,
  });
  setPoolErrorLogger((err) =>
    app.log.warn({ err }, "postgres dropped an idle connection; the pool will reconnect"),
  );

  // Must come before any register() so encapsulated route plugins inherit it.
  registerErrorHandler(app);
  registerCsrfProtection(app);
  registerSecurityHeaders(app, { hsts: options.hsts ?? config.isProduction });
  registerSessionPlugin(app);
  registerHealthRoute(app);
  registerApiRoutes(app, rateLimits);
  mountCollab(
    app,
    [
      docSizeLimitExtension(app.log, { docBytes: limits.docBytes }),
      persistenceExtension(app.log, options.persistence),
      sheetRenameNoticeExtension(),
      awarenessIdentityExtension(app.log),
    ],
    {
      wsMessageBytes: limits.wsMessageBytes,
      wsUpgrade: { perMinute: rateLimits.wsUpgradePerMinute, trustProxy },
    },
  );

  const serveSpa = config.isProduction && existsSync(webDistDir);
  if (serveSpa) {
    void app.register(fastifyStatic, {
      root: webDistDir,
      wildcard: false,
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (serveSpa && request.method === "GET" && !request.url.startsWith("/api/")) {
      void reply.sendFile("index.html");
      return;
    }
    sendApiError(reply, "NOT_FOUND", "Not found");
  });

  return app;
}
