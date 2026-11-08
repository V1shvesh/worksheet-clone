import type { Role } from "@worksheet-clone/shared";
import { workbookParamsSchema } from "@worksheet-clone/shared";
import { can } from "../domain/acl.js";
import { getSessionUser } from "../domain/auth.js";
import { DomainError } from "../domain/errors.js";
import { requireMemberRole } from "../domain/workbooks.js";

export interface CollabContext {
  userId: string;
  /** Server-resolved from the session; used to attribute collab notices. */
  email: string;
  role: Role;
}

export interface CookieReader {
  /** Returns the unsigned session id, or null if missing or forged. */
  readSessionId(cookieHeader: string | null): string | null;
}

// Hocuspocus sends `reason` to the client verbatim, so only these fixed
// strings ever leave the server — never an underlying error message. The
// message is left empty on purpose: Hocuspocus console.errors any hook error
// with a message, and a denied connection is routine, not an error.
export class CollabAuthError extends Error {
  constructor(
    readonly reason: "unauthorized" | "forbidden",
    /** Known once the session resolved; for logs only, never sent to the client. */
    readonly userId?: string,
  ) {
    super("");
  }
}

export interface AuthDecision {
  context: CollabContext;
  readOnly: boolean;
}

export async function authorizeCollabConnection(
  cookies: CookieReader,
  cookieHeader: string | null,
  documentName: string,
): Promise<AuthDecision> {
  const sessionId = cookies.readSessionId(cookieHeader);
  const user = sessionId ? await getSessionUser(sessionId) : null;
  if (!user) {
    throw new CollabAuthError("unauthorized");
  }

  // Document names are workbook ids; anything else can't be a workbook.
  if (!workbookParamsSchema.safeParse({ id: documentName }).success) {
    throw new CollabAuthError("forbidden", user.id);
  }

  let role: Role;
  try {
    role = await requireMemberRole(documentName, user.id);
  } catch (error) {
    if (error instanceof DomainError && error.code === "NOT_FOUND") {
      throw new CollabAuthError("forbidden", user.id);
    }
    throw error;
  }

  return {
    context: { userId: user.id, email: user.email, role },
    readOnly: !can(role, "content:edit"),
  };
}
