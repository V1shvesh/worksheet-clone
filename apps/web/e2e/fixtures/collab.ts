import type { Page, WebSocketRoute } from "@playwright/test";
import { Hocuspocus, type WebSocketLike } from "@hocuspocus/server";
import * as Y from "yjs";
import {
  createEmptyWorkbook,
  diffSheetNames,
  isWorkbookInitialized,
  readSheetNames,
  setSheetName,
  type CollabNotice,
} from "@worksheet-clone/shared";
import { me } from "./workbooks";

/** Who a change or notice is attributed to; the server derives this from the session. */
export interface Author {
  userId: string;
  email: string;
}

export const BOB: Author = {
  userId: "00000000-0000-4000-8000-0000000000b0",
  email: "bob@example.com",
};

const PAGE_USER: Author = { userId: me.id, email: me.email };

export type CollabAccess = "read-write" | "readonly" | "denied";

// Runs the real Hocuspocus engine inside the test process and hands it the
// page's /collab WebSocket via routeWebSocket — real sync protocol, no
// backend, no database, and nothing protocol-specific to maintain here.
export async function mockCollab(
  page: Page,
  options: {
    access: CollabAccess;
    /** The server takes this long to accept the socket (a container waking from sleep). */
    acceptDelayMs?: number;
  },
) {
  const storage = new Map<string, Uint8Array>();
  // Like the real server's sheet-rename notice extension: remember each
  // document's sheet names and broadcast a `sheetRenamed` stateless notice,
  // attributed to the connection's context, whenever a change renames a sheet.
  const nameSnapshots = new Map<string, Map<string, string>>();
  const hocuspocus = new Hocuspocus({
    quiet: true,
    async onAuthenticate({ connectionConfig }) {
      if (options.access === "denied") {
        // Empty message keeps Hocuspocus from logging an expected denial.
        throw Object.assign(new Error(""), { reason: "forbidden" });
      }
      connectionConfig.readOnly = options.access === "readonly";
      return PAGE_USER;
    },
    async afterLoadDocument({ document, documentName }) {
      nameSnapshots.set(documentName, readSheetNames(document));
    },
    async afterUnloadDocument({ documentName }) {
      nameSnapshots.delete(documentName);
    },
    async onChange({ document, documentName, context }) {
      const after = readSheetNames(document);
      const before = nameSnapshots.get(documentName);
      nameSnapshots.set(documentName, after);
      const by = context as Partial<Author> | undefined;
      if (!before || !by?.userId || !by.email) return;
      for (const rename of diffSheetNames(before, after)) {
        const notice: CollabNotice = {
          type: "sheetRenamed",
          by: { userId: by.userId, email: by.email },
          ...rename,
        };
        document.broadcastStateless(JSON.stringify(notice));
      }
    },
    // Persist like the real server (load stored state, seed and store only
    // when there is none). Without this, a doc unloaded after a disconnect
    // would be re-seeded with a new sheet id and merge into two sheets.
    async onLoadDocument({ document, documentName }) {
      const stored = storage.get(documentName);
      if (stored) {
        Y.applyUpdate(document, stored);
      }
      if (!isWorkbookInitialized(document)) {
        createEmptyWorkbook(document);
        storage.set(documentName, Y.encodeStateAsUpdate(document));
      }
    },
    async onStoreDocument({ document, documentName }) {
      storage.set(documentName, Y.encodeStateAsUpdate(document));
    },
  });

  const sockets: WebSocketRoute[] = [];
  // While set, everything the server sends to the page queues up here instead of being
  // delivered (see `holdDelivery`). Order is preserved on release.
  let held: { route: WebSocketRoute; data: Buffer }[] | null = null;
  await page.routeWebSocket(/\/collab$/, (route) => {
    sockets.push(route);
    const socket: WebSocketLike = {
      readyState: 1,
      send: (data) => {
        const bytes = Buffer.from(data as Uint8Array);
        if (held) held.push({ route, data: bytes });
        else route.send(bytes);
      },
      close: (code, reason) => {
        socket.readyState = 3;
        void route.close({ code, reason });
      },
    };
    // With a delay, the page's messages queue behind the (late) connection, in order.
    const accepted = new Promise<void>((resolve) =>
      setTimeout(resolve, options.acceptDelayMs ?? 0),
    );
    const connection = (async () => {
      if (options.acceptDelayMs) await accepted;
      return hocuspocus.handleConnection(socket, new Request(route.url()));
    })();
    route.onMessage(async (message) =>
      (await connection).handleMessage(
        typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message),
      ),
    );
    route.onClose(async (code, reason) =>
      (await connection).handleClose({ code: code ?? 1005, reason: reason ?? "" }),
    );
  });

  return {
    /** A collaborator editing the same workbook through the server. */
    async remoteEdit(
      workbookId: string,
      change: (doc: Y.Doc) => void,
      author: Author = BOB,
    ): Promise<void> {
      const direct = await hocuspocus.openDirectConnection(workbookId, author);
      await direct.transact(change);
      await direct.disconnect();
    },
    /** A collaborator renames a tab; every connected page receives the same notice the server sends. */
    async renameSheet(
      workbookId: string,
      sheetId: string,
      name: string,
      author: Author = BOB,
    ): Promise<void> {
      const direct = await hocuspocus.openDirectConnection(workbookId, author);
      await direct.transact((doc) => setSheetName(doc, sheetId, name));
      await direct.disconnect();
    },
    /** What the server does after a successful PATCH /api/workbooks/:id. */
    broadcastWorkbookRenamed(workbookId: string, by: Author, from: string, to: string): void {
      const notice: CollabNotice = { type: "workbookRenamed", by, from, to };
      hocuspocus.documents.get(workbookId)?.broadcastStateless(JSON.stringify(notice));
    },
    /** The server's copy of the document (in memory, else last stored). */
    serverDoc(workbookId: string): Y.Doc | undefined {
      const live = hocuspocus.documents.get(workbookId);
      if (live) return live;
      const stored = storage.get(workbookId);
      if (!stored) return undefined;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, stored);
      return doc;
    },
    /**
     * Counts Yjs updates the server applies to a workbook from now on (client edits and
     * remote edits alike). Call after the page has connected, so the live doc exists.
     */
    countUpdates(workbookId: string): { readonly count: number; stop(): void } {
      const doc = hocuspocus.documents.get(workbookId);
      if (!doc) throw new Error(`workbook ${workbookId} is not loaded on the server`);
      let count = 0;
      const onUpdate = () => {
        count += 1;
      };
      doc.on("update", onUpdate);
      return {
        get count() {
          return count;
        },
        stop: () => doc.off("update", onUpdate),
      };
    },
    /**
     * Holds back everything the server sends to the page, as a slow downlink would, while the
     * page's own messages still reach the server. The page's view stays frozen at the moment of
     * the call, so a test can let the server (or a collaborator) get ahead of it
     * deterministically; `releaseDelivery` then delivers the queue in order.
     */
    holdDelivery(): void {
      held ??= [];
    },
    releaseDelivery(): void {
      const queue = held ?? [];
      held = null;
      for (const { route, data } of queue) route.send(data);
    },
    /** Simulates the network dropping every open socket. */
    dropConnections(): void {
      for (const route of sockets.splice(0)) {
        void route.close({ code: 1006, reason: "network lost" });
      }
    },
  };
}
