import { and, desc, eq, sql } from "drizzle-orm";
import type { Role } from "@worksheet-clone/shared";
import { db } from "../db/client.js";
import { workbookMembers, workbooks } from "../db/schema.js";
import { assertCan } from "./acl.js";
import { DomainError } from "./errors.js";

export interface WorkbookWithRole {
  id: string;
  name: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

// Non-members get NOT_FOUND rather than FORBIDDEN so they can't probe which
// workbook ids exist.
export async function requireMemberRole(workbookId: string, userId: string): Promise<Role> {
  const [row] = await db
    .select({ role: workbookMembers.role })
    .from(workbookMembers)
    .where(and(eq(workbookMembers.workbookId, workbookId), eq(workbookMembers.userId, userId)))
    .limit(1);

  if (!row) {
    throw new DomainError("NOT_FOUND", "Workbook not found");
  }
  return row.role;
}

const workbookWithRoleColumns = {
  id: workbooks.id,
  name: workbooks.name,
  role: workbookMembers.role,
  createdAt: workbooks.createdAt,
  updatedAt: workbooks.updatedAt,
};

export async function listWorkbooks(userId: string): Promise<WorkbookWithRole[]> {
  return db
    .select(workbookWithRoleColumns)
    .from(workbookMembers)
    .innerJoin(workbooks, eq(workbookMembers.workbookId, workbooks.id))
    .where(eq(workbookMembers.userId, userId))
    .orderBy(desc(workbooks.updatedAt));
}

export async function getWorkbook(userId: string, workbookId: string): Promise<WorkbookWithRole> {
  const role = await requireMemberRole(workbookId, userId);
  assertCan(role, "workbook:read");

  const [workbook] = await db.select().from(workbooks).where(eq(workbooks.id, workbookId));
  if (!workbook) {
    throw new DomainError("NOT_FOUND", "Workbook not found");
  }
  return { ...workbook, role };
}

export async function createWorkbook(userId: string, name: string): Promise<WorkbookWithRole> {
  return db.transaction(async (tx) => {
    const [workbook] = await tx.insert(workbooks).values({ name }).returning();
    if (!workbook) {
      throw new Error("insert into workbooks returned no row");
    }
    await tx.insert(workbookMembers).values({ workbookId: workbook.id, userId, role: "owner" });
    return { ...workbook, role: "owner" as const };
  });
}

export interface RenamedWorkbook extends WorkbookWithRole {
  /** The name before this rename, read in the same transaction as the update. */
  previousName: string;
}

export async function renameWorkbook(
  userId: string,
  workbookId: string,
  name: string,
): Promise<RenamedWorkbook> {
  const role = await requireMemberRole(workbookId, userId);
  assertCan(role, "workbook:rename");

  // Lock the row while reading the old name so two concurrent renames each
  // report the name they actually replaced.
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select({ name: workbooks.name })
      .from(workbooks)
      .where(eq(workbooks.id, workbookId))
      .for("update");
    if (!before) {
      throw new DomainError("NOT_FOUND", "Workbook not found");
    }
    const [workbook] = await tx
      .update(workbooks)
      .set({ name, updatedAt: sql`now()` })
      .where(eq(workbooks.id, workbookId))
      .returning();
    if (!workbook) {
      throw new DomainError("NOT_FOUND", "Workbook not found");
    }
    return { ...workbook, role, previousName: before.name };
  });
}

export async function deleteWorkbook(userId: string, workbookId: string): Promise<void> {
  const role = await requireMemberRole(workbookId, userId);
  assertCan(role, "workbook:delete");

  await db.delete(workbooks).where(eq(workbooks.id, workbookId));
}
