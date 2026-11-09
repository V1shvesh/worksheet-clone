import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Client } from "pg";

// Next to this file: src/db/migrations under tsx, dist/db/migrations after
// `pnpm build` (the build script copies the folder; tsc only emits .js).
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("./migrations", import.meta.url));

// Arbitrary constant shared by every instance of this app: whoever holds this
// session-level advisory lock is the only one migrating.
const MIGRATION_LOCK_KEY = 7_262_026;

export interface MigrationLogger {
  info(fields: Record<string, unknown>, message: string): void;
}

export interface MigrationResult {
  /** Tags of the migrations this call applied (empty when someone else already did). */
  applied: string[];
}

interface JournalEntry {
  tag: string;
  when: number;
}

function readJournal(folder: string): JournalEntry[] {
  const raw = readFileSync(`${folder}/meta/_journal.json`, "utf8");
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

/**
 * Applies pending migrations on a dedicated connection that holds a Postgres
 * advisory lock, so two instances starting at once (a rolling deploy) can't
 * migrate concurrently: the second waits, then finds nothing left to do.
 *
 * `url` should be the direct (unpooled) connection: session-level advisory locks
 * do not survive a transaction-mode pooler such as Neon's pgbouncer.
 */
export async function runMigrations(options: {
  url: string;
  folder?: string;
  log?: MigrationLogger;
}): Promise<MigrationResult> {
  const folder = options.folder ?? MIGRATIONS_FOLDER;
  const client = new Client({ connectionString: options.url });
  // A client that errors while idle (connection dropped mid-wait) would throw
  // as an unhandled "error" event; the in-flight query rejects as well.
  client.on("error", () => undefined);
  await client.connect();
  try {
    options.log?.info({}, "waiting for the migration lock");
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    try {
      const lastApplied = await lastAppliedAt(client);
      const pending = readJournal(folder).filter((entry) => entry.when > lastApplied);
      await migrate(drizzle(client), { migrationsFolder: folder });
      const applied = pending.map((entry) => entry.tag);
      options.log?.info(
        { applied },
        applied.length > 0 ? "applied database migrations" : "database is up to date",
      );
      return { applied };
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}

async function lastAppliedAt(client: Client): Promise<number> {
  const exists = await client.query<{ present: string | null }>(
    "select to_regclass('drizzle.__drizzle_migrations') as present",
  );
  if (!exists.rows[0]?.present) {
    return Number.NEGATIVE_INFINITY;
  }
  const result = await client.query<{ created_at: string | null }>(
    "select max(created_at) as created_at from drizzle.__drizzle_migrations",
  );
  const value = result.rows[0]?.created_at;
  return value ? Number(value) : Number.NEGATIVE_INFINITY;
}
