import { and, asc, eq, sql } from "drizzle-orm";
import type { AssignableRole, Member } from "@worksheet-clone/shared";
import { db } from "../db/client.js";
import { users, workbookMembers } from "../db/schema.js";
import { assertCan } from "./acl.js";
import { DomainError } from "./errors.js";
import { requireMemberRole } from "./workbooks.js";

const memberColumns = {
  userId: workbookMembers.userId,
  email: users.email,
  role: workbookMembers.role,
};

export async function listMembers(actorId: string, workbookId: string): Promise<Member[]> {
  const role = await requireMemberRole(workbookId, actorId);
  assertCan(role, "members:read");

  return db
    .select(memberColumns)
    .from(workbookMembers)
    .innerJoin(users, eq(workbookMembers.userId, users.id))
    .where(eq(workbookMembers.workbookId, workbookId))
    .orderBy(sql`${workbookMembers.role} = 'owner' desc`, asc(users.email));
}

export async function addMember(
  actorId: string,
  workbookId: string,
  email: string,
  role: AssignableRole,
): Promise<Member> {
  const actorRole = await requireMemberRole(workbookId, actorId);
  assertCan(actorRole, "members:manage");

  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    throw new DomainError("USER_NOT_FOUND", "No account exists with that email");
  }

  // onConflictDoNothing instead of check-then-insert, so two concurrent adds
  // of the same person can't surface as a 500 from the primary key.
  const inserted = await db
    .insert(workbookMembers)
    .values({ workbookId, userId: user.id, role })
    .onConflictDoNothing()
    .returning({ userId: workbookMembers.userId });
  if (inserted.length === 0) {
    throw new DomainError("ALREADY_MEMBER", "That person already has access to this workbook");
  }

  return { userId: user.id, email: user.email, role };
}

async function requireNonOwnerTarget(workbookId: string, targetUserId: string): Promise<void> {
  const [target] = await db
    .select({ role: workbookMembers.role })
    .from(workbookMembers)
    .where(
      and(eq(workbookMembers.workbookId, workbookId), eq(workbookMembers.userId, targetUserId)),
    )
    .limit(1);

  if (!target) {
    throw new DomainError("NOT_FOUND", "Member not found");
  }
  if (target.role === "owner") {
    throw new DomainError("INVALID_MEMBER_OPERATION", "The owner can't be changed or removed");
  }
}

export async function changeMemberRole(
  actorId: string,
  workbookId: string,
  targetUserId: string,
  role: AssignableRole,
): Promise<Member> {
  const actorRole = await requireMemberRole(workbookId, actorId);
  assertCan(actorRole, "members:manage");
  await requireNonOwnerTarget(workbookId, targetUserId);

  await db
    .update(workbookMembers)
    .set({ role })
    .where(
      and(eq(workbookMembers.workbookId, workbookId), eq(workbookMembers.userId, targetUserId)),
    );

  const [member] = await db
    .select(memberColumns)
    .from(workbookMembers)
    .innerJoin(users, eq(workbookMembers.userId, users.id))
    .where(
      and(eq(workbookMembers.workbookId, workbookId), eq(workbookMembers.userId, targetUserId)),
    );
  if (!member) {
    throw new DomainError("NOT_FOUND", "Member not found");
  }
  return member;
}

export async function removeMember(
  actorId: string,
  workbookId: string,
  targetUserId: string,
): Promise<void> {
  const actorRole = await requireMemberRole(workbookId, actorId);
  assertCan(actorRole, "members:manage");
  await requireNonOwnerTarget(workbookId, targetUserId);

  await db
    .delete(workbookMembers)
    .where(
      and(eq(workbookMembers.workbookId, workbookId), eq(workbookMembers.userId, targetUserId)),
    );
}
