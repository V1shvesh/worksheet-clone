// Imported first: validates the environment and exits with a readable message
// before anything else (the database pool, the session plugin) reads it.
import { config } from "./config.js";
import { buildApp } from "./app.js";
import { pool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { scheduleSessionCleanup } from "./session-cleanup.js";
import { installShutdownHandlers } from "./shutdown.js";

const app = buildApp();

installShutdownHandlers({
  close: () => app.close(),
  closeDatabase: () => pool.end(),
  log: {
    info: (message) => app.log.info(message),
    error: (fields, message) => app.log.error(fields, message),
  },
});

try {
  // Before listening: no request or WebSocket can reach a half-migrated schema.
  await runMigrations({ url: config.databaseUrlUnpooled, log: app.log });
  // Registers an onClose hook, which Fastify only accepts before listen().
  scheduleSessionCleanup(app);
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (error) {
  app.log.error({ err: error }, "start-up failed");
  process.exit(1);
}
