import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, runMigrations } from "../../src/db/migrate.js";
import { createScratchDatabase, urlForDatabase } from "../helpers/scratch-db.js";

const journal = JSON.parse(readFileSync(`${MIGRATIONS_FOLDER}/meta/_journal.json`, "utf8")) as {
  entries: { tag: string }[];
};
const allTags = journal.entries.map((entry) => entry.tag);

describe("runMigrations", () => {
  const scratch: Awaited<ReturnType<typeof createScratchDatabase>>[] = [];

  async function freshDatabase(): Promise<string> {
    const database = await createScratchDatabase();
    scratch.push(database);
    return database.url;
  }

  afterAll(async () => {
    await Promise.all(scratch.map((database) => database.drop()));
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
    await expect(
      runMigrations({ url: urlForDatabase(`does_not_exist_${Date.now()}`) }),
    ).rejects.toThrow();
  });
});
