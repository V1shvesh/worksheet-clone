import type { Hocuspocus } from "@hocuspocus/server";
import { COLLAB_CLOSE_CODES, COLLAB_CLOSE_REASONS } from "@worksheet-clone/shared";
import type { CollabContext } from "./auth.js";

// Closes the whole WebSocket, not just the document connection: a
// per-document close only marks the provider unauthenticated while its socket
// stays open, so it never re-authenticates. A socket close makes the provider
// reconnect and onAuthenticate decide afresh — a demoted editor comes back
// read-only, a removed member is refused.
const ACCESS_CHANGED_CODE = COLLAB_CLOSE_CODES.accessChanged;
const ACCESS_CHANGED_REASON = COLLAB_CLOSE_REASONS.accessChanged;

/** Disconnect one user's live sessions on a workbook (role change or removal). */
export function revokeUserAccess(
  hocuspocus: Hocuspocus<CollabContext>,
  workbookId: string,
  userId: string,
): void {
  const document = hocuspocus.documents.get(workbookId);
  for (const connection of document?.getConnections() ?? []) {
    if (connection.context.userId === userId) {
      connection.webSocket.close(ACCESS_CHANGED_CODE, ACCESS_CHANGED_REASON);
    }
  }
}

/** Disconnect everyone from a workbook (it was deleted). */
export function revokeAllAccess(hocuspocus: Hocuspocus<CollabContext>, workbookId: string): void {
  const document = hocuspocus.documents.get(workbookId);
  for (const connection of document?.getConnections() ?? []) {
    connection.webSocket.close(ACCESS_CHANGED_CODE, ACCESS_CHANGED_REASON);
  }
}
