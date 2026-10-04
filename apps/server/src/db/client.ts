import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set");
  }
  return url;
}

// min: 0 and a short idle timeout let the pool close all connections when
// idle, so the container can sleep on Railway (see PROJECT_CONTEXT §2.4).
export const pool = new Pool({
  connectionString: requireDatabaseUrl(),
  min: 0,
  idleTimeoutMillis: 10_000,
});

export const db = drizzle(pool, { schema });
