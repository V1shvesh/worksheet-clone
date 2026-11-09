import { config } from "../config.js";
import { runMigrations } from "./migrate.js";

// `pnpm db:migrate` (tsx) and `node dist/db/migrate-cli.js` (production image).
try {
  const { applied } = await runMigrations({
    url: config.databaseUrlUnpooled,
    log: { info: (fields, message) => console.log(message, JSON.stringify(fields)) },
  });
  console.log(`migrations done (${applied.length} applied)`);
} catch (error) {
  console.error("migration failed:", error);
  process.exit(1);
}
