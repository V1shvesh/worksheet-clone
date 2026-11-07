import { sql } from "drizzle-orm";
import { db } from "../../src/db/client.js";
import { signup } from "../../src/domain/auth.js";
import type { AuthUser } from "@worksheet-clone/shared";

// Test files share one Postgres and run concurrently, so each file owns a
// unique email prefix and only ever deletes rows reachable from it.
export function testEmails(prefix: string): { pattern: string; next: () => string } {
  return {
    pattern: `${prefix}-%@example.com`,
    next: () => `${prefix}-${crypto.randomUUID()}@example.com`,
  };
}

export async function cleanupByEmailPattern(pattern: string): Promise<void> {
  await db.execute(sql`
    delete from workbooks where id in (
      select wm.workbook_id from workbook_members wm
      join users u on u.id = wm.user_id
      where u.email like ${pattern}
    )
  `);
  await db.execute(sql`delete from users where email like ${pattern}`);
}

export async function createUser(email: string): Promise<AuthUser> {
  return signup(email, "correct-password");
}
