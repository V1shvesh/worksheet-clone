import type { Extension, Hocuspocus } from "@hocuspocus/server";
import { diffSheetNames, readSheetNames, type CollabNotice } from "@worksheet-clone/shared";
import type { CollabContext } from "./auth.js";

function send(hocuspocus: Hocuspocus<CollabContext>, workbookId: string, notice: CollabNotice) {
  // Not loaded means nobody is connected: nobody to tell.
  hocuspocus.documents.get(workbookId)?.broadcastStateless(JSON.stringify(notice));
}

/** Tell everyone connected to a workbook that `user` renamed it (REST path). */
export function broadcastWorkbookRenamed(
  hocuspocus: Hocuspocus<CollabContext>,
  workbookId: string,
  user: { id: string; email: string },
  from: string,
  to: string,
): void {
  send(hocuspocus, workbookId, {
    type: "workbookRenamed",
    by: { userId: user.id, email: user.email },
    from,
    to,
  });
}

/**
 * Keeps a per-document snapshot of sheet names and, when a client's change
 * renames a sheet, broadcasts a `sheetRenamed` notice attributed to the
 * sending connection's server-side context. The sender receives it too; the
 * client filters notices about itself.
 */
export function sheetRenameNoticeExtension(): Extension {
  const snapshots = new Map<string, Map<string, string>>();

  return {
    extensionName: "sheet-rename-notices",

    async afterLoadDocument({ document, documentName }) {
      snapshots.set(documentName, readSheetNames(document));
    },

    async afterUnloadDocument({ documentName }) {
      snapshots.delete(documentName);
    },

    async onChange({ document, documentName, context }) {
      const after = readSheetNames(document);
      const before = snapshots.get(documentName);
      snapshots.set(documentName, after);
      // No snapshot yet (a change during load) or no user (server's own
      // transaction, direct connection): update silently.
      const user = (context as Partial<CollabContext> | undefined) ?? {};
      if (!before || !user.userId || !user.email) return;

      for (const rename of diffSheetNames(before, after)) {
        document.broadcastStateless(
          JSON.stringify({
            type: "sheetRenamed",
            by: { userId: user.userId, email: user.email },
            ...rename,
          } satisfies CollabNotice),
        );
      }
    },
  };
}
