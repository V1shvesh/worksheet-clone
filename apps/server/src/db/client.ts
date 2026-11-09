import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

// min: 0 and a short idle timeout let the pool close all connections when
// idle, so the container can sleep on Railway (see PROJECT_CONTEXT §2.4).
export const pool = new Pool({
  connectionString: config.databaseUrl,
  min: 0,
  idleTimeoutMillis: 10_000,
});

// When Postgres drops an idle connection (a restart, failover, or Neon scaling to zero), the pool
// emits "error" for that idle client. An EventEmitter "error" with no listener throws, and that
// crashed the whole server. The pool already discards the broken client and opens a new one on
// the next query, so this only needs logging. buildApp points it at the app's logger.
type PoolErrorLogger = (error: Error) => void;
let logPoolError: PoolErrorLogger = (error) =>
  console.error(`postgres: idle connection error: ${error.message}`);
pool.on("error", (error) => logPoolError(error));

export function setPoolErrorLogger(logger: PoolErrorLogger): void {
  logPoolError = logger;
}

export const db = drizzle(pool, { schema });
