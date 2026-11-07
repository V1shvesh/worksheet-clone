import type { Hocuspocus } from "@hocuspocus/server";
import type { CollabContext } from "./auth.js";

// Closes the whole WebSocket, not just the document connection: a
// per-document close only marks the provider unauthenticated while its socket
// stays open, so it never re-authenticates. A socket close makes the provider
// reconnect and onAuthenticate decide afresh — a demoted editor comes back
// read-only, a removed member is refused. 4205 matches Hocuspocus's own
// ResetConnection code (not exported by @hocuspocus/server).
const ACCESS_CHANGED_CODE = 4205;
const ACCESS_CHANGED_REASON = "access-changed";

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
