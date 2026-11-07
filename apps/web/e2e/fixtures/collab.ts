import type { Page, WebSocketRoute } from "@playwright/test";
import { Hocuspocus, type WebSocketLike } from "@hocuspocus/server";
import * as Y from "yjs";
import { createEmptyWorkbook, isWorkbookInitialized } from "@worksheet-clone/shared";

export type CollabAccess = "read-write" | "readonly" | "denied";

// Runs the real Hocuspocus engine inside the test process and hands it the
// page's /collab WebSocket via routeWebSocket — real sync protocol, no
// backend, no database, and nothing protocol-specific to maintain here.
export async function mockCollab(page: Page, options: { access: CollabAccess }) {
  const storage = new Map<string, Uint8Array>();
  const hocuspocus = new Hocuspocus({
    quiet: true,
    async onAuthenticate({ connectionConfig }) {
      if (options.access === "denied") {
        // Empty message keeps Hocuspocus from logging an expected denial.
        throw Object.assign(new Error(""), { reason: "forbidden" });
      }
      connectionConfig.readOnly = options.access === "readonly";
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
  await page.routeWebSocket(/\/collab$/, (route) => {
    sockets.push(route);
    const socket: WebSocketLike = {
      readyState: 1,
      send: (data) => route.send(Buffer.from(data as Uint8Array)),
      close: (code, reason) => {
        socket.readyState = 3;
        void route.close({ code, reason });
      },
    };
    const connection = hocuspocus.handleConnection(socket, new Request(route.url()));
    route.onMessage((message) =>
      connection.handleMessage(
        typeof message === "string" ? new TextEncoder().encode(message) : new Uint8Array(message),
      ),
    );
    route.onClose((code, reason) =>
      connection.handleClose({ code: code ?? 1005, reason: reason ?? "" }),
    );
  });

  return {
    /** A collaborator editing the same workbook through the server. */
    async remoteEdit(workbookId: string, change: (doc: Y.Doc) => void): Promise<void> {
      const direct = await hocuspocus.openDirectConnection(workbookId);
      await direct.transact(change);
      await direct.disconnect();
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
    /** Simulates the network dropping every open socket. */
    dropConnections(): void {
      for (const route of sockets.splice(0)) {
        void route.close({ code: 1006, reason: "network lost" });
      }
    },
  };
}
