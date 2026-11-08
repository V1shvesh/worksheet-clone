import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuthRoutes } from "./http/auth.js";
import { registerErrorHandler, sendApiError } from "./http/errors.js";
import { registerHealthRoute } from "./http/health.js";
import { registerMemberRoutes } from "./http/members.js";
import { registerSessionPlugin } from "./http/session.js";
import { registerWorkbookRoutes } from "./http/workbooks.js";
import { awarenessIdentityExtension } from "./realtime/awareness.js";
import { buildLoggerOptions } from "./logging.js";
import { mountCollab } from "./realtime/collab.js";
import { sheetRenameNoticeExtension } from "./realtime/notices.js";
import { persistenceExtension, type PersistenceOptions } from "./realtime/persistence.js";

// In the monorepo (and the pre-pack Docker build stage), apps/web/dist sits
// two levels up from this file. The final Docker runtime stage copies that
// directory to a fixed location and points WEB_DIST_DIR at it instead,
// since it doesn't keep the monorepo's directory layout.
const webDistDir =
  process.env.WEB_DIST_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));

export interface BuildAppOptions {
  /** Test seams (failing store, short retry delays); production passes none. */
  persistence?: PersistenceOptions;
  /** Test seam: capture log lines (default: stdout). */
  logStream?: { write(message: string): void };
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: buildLoggerOptions(options.logStream) });

  // Must come before any register() so encapsulated route plugins inherit it.
  registerErrorHandler(app);
  registerSessionPlugin(app);
  registerHealthRoute(app);
  registerAuthRoutes(app);
  registerWorkbookRoutes(app);
  registerMemberRoutes(app);
  mountCollab(app, [
    persistenceExtension(app.log, options.persistence),
    sheetRenameNoticeExtension(),
    awarenessIdentityExtension(app.log),
  ]);

  const serveSpa = process.env.NODE_ENV === "production" && existsSync(webDistDir);
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
