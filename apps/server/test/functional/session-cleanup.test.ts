import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { db, pool } from "../../src/db/client.js";
import { deleteExpiredSessions } from "../../src/domain/auth.js";
import { sessions } from "../../src/db/schema.js";
import { scheduleSessionCleanup } from "../../src/session-cleanup.js";
import { cleanupByEmailPattern, createUser, testEmails } from "../helpers/db.js";
import { waitFor } from "../helpers/collab.js";

const emails = testEmails("test-sessioncleanup");

afterEach(async () => {
  await cleanupByEmailPattern(emails.pattern);
});
afterAll(async () => {
  await pool.end();
});

describe("deleteExpiredSessions", () => {
  it("removes expired sessions and keeps live ones", async () => {
    const user = await createUser(emails.next());
    const hour = 60 * 60 * 1000;
    const [expired, live] = await db
      .insert(sessions)
      .values([
        { userId: user.id, expiresAt: new Date(Date.now() - hour) },
        { userId: user.id, expiresAt: new Date(Date.now() + hour) },
      ])
      .returning({ id: sessions.id });

    const deleted = await deleteExpiredSessions();

    expect(deleted).toBeGreaterThanOrEqual(1);
    const left = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, user.id));
    expect(left.map((row) => row.id)).toEqual([live?.id]);
    expect(left.map((row) => row.id)).not.toContain(expired?.id);
  });
});

describe("scheduleSessionCleanup", () => {
  it("runs at once, repeats on the interval, and stops when the app closes", async () => {
    const app = buildApp({ logStream: { write: () => undefined } });
    let runs = 0;
    scheduleSessionCleanup(app, {
      intervalMs: 20,
      run: async () => {
        runs += 1;
        return 0;
      },
    });

    await waitFor(() => runs >= 3);
    await app.close();
    const atClose = runs;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runs).toBe(atClose);
  });

  it("logs a failure and keeps going", async () => {
    const lines: string[] = [];
    const app = buildApp({ logStream: { write: (line) => void lines.push(line) } });
    let runs = 0;
    scheduleSessionCleanup(app, {
      intervalMs: 20,
      run: async () => {
        runs += 1;
        throw new Error("db down");
      },
    });
    await waitFor(() => runs >= 2);
    await app.close();
    expect(lines.join("")).toContain("deleting expired sessions failed");
  });

  it("deletes for real through the default job", async () => {
    const user = await createUser(emails.next());
    await db.insert(sessions).values({ userId: user.id, expiresAt: new Date(Date.now() - 1000) });
    const app = buildApp({ logStream: { write: () => undefined } });
    scheduleSessionCleanup(app);
    const remaining = async (): Promise<number> => {
      const { rows } = await db.execute(
        sql`select count(*)::int as n from sessions where user_id = ${user.id}`,
      );
      return (rows[0] as { n: number }).n;
    };
    const deadline = Date.now() + 3_000;
    while ((await remaining()) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await remaining()).toBe(0);
    await app.close();
  });
});
