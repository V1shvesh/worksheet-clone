import { Client } from "pg";
import { config } from "../../src/config.js";

export function urlForDatabase(database: string): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** A throwaway empty database on the test Postgres, for tests that migrate or boot a whole server. */
export async function createScratchDatabase(): Promise<{
  url: string;
  drop: () => Promise<void>;
}> {
  const name = `scratch_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: config.databaseUrl });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  return {
    url: urlForDatabase(name),
    drop: async () => {
      const dropper = new Client({ connectionString: config.databaseUrl });
      await dropper.connect();
      try {
        await dropper.query(`drop database if exists ${name} with (force)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
