import type { Connection, Extension } from "@hocuspocus/server";
import type { FastifyBaseLogger } from "fastify";
import type { CollabContext } from "./auth.js";

// Presence is client-published, so on its own any member could claim to be
// someone else (or erase a collaborator's cursor). Hocuspocus 4.8 decodes each
// inbound awareness update into a mutable per-client map before applying and
// broadcasting it (MessageReceiver.ts, case MessageType.Awareness ->
// beforeHandleAwareness; whatever is left in `states`/`removedClients` is
// re-encoded and forwarded). This hook is therefore the narrowest place to
// enforce identity, and it runs for read-only connections too (their awareness
// is never dropped: viewers still show up as collaborators).
//
// Rules, per sending connection (context comes from the session, not the client):
//  - a state must carry `user.id` equal to the session's user id, otherwise it is dropped;
//  - `user.email` is overwritten with the session's email;
//  - a clientId already owned by ANOTHER USER's connection can't be overwritten or removed;
//  - a connection can only remove clientIds it published itself;
//  - oversized states are dropped.
// Updates that don't come from a client connection (context undefined) pass untouched.

const MAX_STATE_BYTES = 2_048;

export function awarenessIdentityExtension(log: FastifyBaseLogger): Extension {
  // Log a connection's first violation only: a spoofing client could otherwise
  // flood the logs with one line per cursor move.
  const reported = new WeakSet<Connection>();

  return {
    extensionName: "awareness-identity",

    async beforeHandleAwareness({
      context,
      connection,
      document,
      documentName,
      states,
      removedClients,
    }) {
      const user = context as Partial<CollabContext> | undefined;
      if (!user?.userId || !connection) return;

      const owned = document.getClients(connection);
      // Another connection of the SAME user may hold the id: a reconnecting
      // client keeps its Yjs clientID while the server may not have noticed
      // the old socket die yet.
      const foreignClientIds = new Set<number>();
      for (const [other] of document.connections) {
        const otherUserId = (other.context as Partial<CollabContext> | undefined)?.userId;
        if (other !== connection && otherUserId !== user.userId) {
          for (const clientId of document.getClients(other)) foreignClientIds.add(clientId);
        }
      }

      let rejected = 0;
      for (const [clientId, state] of states) {
        const claimed = (state as { user?: { id?: unknown } } | null)?.user;
        const valid =
          !foreignClientIds.has(clientId) &&
          typeof claimed === "object" &&
          claimed !== null &&
          claimed.id === user.userId &&
          JSON.stringify(state).length <= MAX_STATE_BYTES;
        if (!valid) {
          states.delete(clientId);
          rejected += 1;
          continue;
        }
        (state as { user: Record<string, unknown> }).user.email = user.email;
      }
      for (const clientId of [...removedClients]) {
        if (!owned.has(clientId)) {
          removedClients.delete(clientId);
          rejected += 1;
        }
      }

      if (rejected > 0 && !reported.has(connection)) {
        reported.add(connection);
        log.warn(
          { workbookId: documentName, userId: user.userId, rejected },
          "dropped awareness states that don't match the connection's session",
        );
      }
    },
  };
}
