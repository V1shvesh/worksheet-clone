import argon2 from "argon2";
import { eq, lt } from "drizzle-orm";
import type { AuthUser } from "@worksheet-clone/shared";
import { db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { DomainError } from "./errors.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export interface Session {
  id: string;
  expiresAt: Date;
}

export async function signup(email: string, password: string): Promise<AuthUser> {
  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (existing) {
    throw new DomainError("EMAIL_TAKEN", "An account with this email already exists");
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const [user] = await db
    .insert(users)
    .values({ email, passwordHash })
    .returning({ id: users.id, email: users.email });

  if (!user) {
    throw new Error("insert into users returned no row");
  }

  return user;
}

export async function login(email: string, password: string): Promise<AuthUser> {
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user || !(await argon2.verify(user.passwordHash, password))) {
    throw new DomainError("INVALID_CREDENTIALS", "Invalid email or password");
  }

  return { id: user.id, email: user.email };
}

export async function createSession(userId: string): Promise<Session> {
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const [session] = await db
    .insert(sessions)
    .values({ userId, expiresAt })
    .returning({ id: sessions.id, expiresAt: sessions.expiresAt });

  if (!session) {
    throw new Error("insert into sessions returned no row");
  }

  return session;
}

export async function deleteSession(sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function getSessionUser(sessionId: string): Promise<AuthUser | null> {
  const [row] = await db
    .select({
      userId: users.id,
      email: users.email,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);

  if (!row) {
    return null;
  }

  if (row.expiresAt.getTime() < Date.now()) {
    await deleteSession(sessionId);
    return null;
  }

  return { id: row.userId, email: row.email };
}

/** Removes sessions past their expiry (they are otherwise only removed when presented). Returns how many. */
export async function deleteExpiredSessions(now: Date = new Date()): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return deleted.length;
}
