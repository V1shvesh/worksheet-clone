import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../../src/config.js";
import { MIGRATIONS_FOLDER, runMigrations } from "../../src/db/migrate.js";

const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, "utf8")) as {
  entries: { tag: string }[];
};
const allTags = journal.entries.map((entry) => entry.tag);

// Migrations run against a throwaway database so they start from empty, whatever
// state the shared test database is in.
function urlFor(database: string): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

describe("runMigrations", () => {
  const admin = new Client({ connectionString: config.databaseUrl });
  const created: string[] = [];

  async function freshDatabase(): Promise<string> {
    const name = `migrate_test_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database ${name}`);
    created.push(name);
    return urlFor(name);
  }

  beforeAll(async () => {
    await admin.connect();
  });

  afterAll(async () => {
    for (const name of created) {
      await admin.query(`drop database if exists ${name} with (force)`);
    }
    await admin.end();
  });

  it("applies every migration on an empty database, then does nothing", async () => {
    const url = await freshDatabase();
    const first = await runMigrations({ url });
    expect(first.applied).toEqual(allTags);
    const second = await runMigrations({ url });
    expect(second.applied).toEqual([]);
  });

  it("lets two concurrent starts both succeed, with exactly one doing the work", async () => {
    const url = await freshDatabase();
    const results = await Promise.all([runMigrations({ url }), runMigrations({ url })]);
    const applied = results.map((result) => result.applied);
    expect(applied.flat().sort()).toEqual([...allTags].sort());
    expect(applied.filter((tags) => tags.length > 0)).toHaveLength(1);

    const check = new Client({ connectionString: url });
    await check.connect();
    try {
      const { rows } = await check.query("select count(*)::int as n from users");
      expect(rows[0].n).toBe(0);
    } finally {
      await check.end();
    }
  });

  it("rejects when the database does not exist", async () => {
    await expect(runMigrations({ url: urlFor("does_not_exist_" + Date.now()) })).rejects.toThrow();
  });
});
