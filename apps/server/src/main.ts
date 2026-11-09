// Imported first: validates the environment and exits with a readable message
// before anything else (the database pool, the session plugin) reads it.
import { config } from "./config.js";
import { buildApp } from "./app.js";
import { runMigrations } from "./db/migrate.js";

const app = buildApp();

try {
  // Before listening: no request or WebSocket can reach a half-migrated schema.
  await runMigrations({ url: config.databaseUrlUnpooled, log: app.log });
  await app.listen({ port: config.port, host: "0.0.0.0" });
} catch (error) {
  app.log.error({ err: error }, "start-up failed");
  process.exit(1);
}
