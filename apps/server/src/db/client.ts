import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

// Falls back to the local docker-compose Postgres so dev/test don't need a
// .env file; production (Railway) always sets DATABASE_URL explicitly.
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://worksheet:worksheet@localhost:5432/worksheet";

// min: 0 and a short idle timeout let the pool close all connections when
// idle, so the container can sleep on Railway (see PROJECT_CONTEXT §2.4).
export const pool = new Pool({
  connectionString: DATABASE_URL,
  min: 0,
  idleTimeoutMillis: 10_000,
});

export const db = drizzle(pool, { schema });
