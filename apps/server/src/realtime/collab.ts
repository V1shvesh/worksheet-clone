import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Hocuspocus, type Extension, type WebSocketLike } from "@hocuspocus/server";
import crossws from "crossws/adapters/node";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE_NAME } from "../http/session.js";
import { authorizeCollabConnection, CollabAuthError, type CollabContext } from "./auth.js";

export const COLLAB_PATH = "/collab";

declare module "fastify" {
  interface FastifyInstance {
    collab: Hocuspocus<CollabContext>;
  }
}

// Browsers attach cookies to cross-origin WebSocket handshakes, so without
// this check any site could open a socket as the signed-in user. Comparing
// Origin to Host needs no configuration and pages can't forge Origin.
export function isSameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function mountCollab(app: FastifyInstance, extensions: Extension[] = []): void {
  const cookies = {
    readSessionId(cookieHeader: string | null): string | null {
      const raw = cookieHeader ? app.parseCookie(cookieHeader)[SESSION_COOKIE_NAME] : undefined;
      const unsigned = raw ? app.unsignCookie(raw) : null;
      return unsigned?.valid && unsigned.value ? unsigned.value : null;
    },
  };

  const hocuspocus = new Hocuspocus<CollabContext>({
    quiet: true,
    extensions,
    // Store at most every 2s while edits arrive, and at least every 10s
    // during continuous editing; the last disconnect stores immediately.
    debounce: 2_000,
    maxDebounce: 10_000,
    async onAuthenticate({ requestHeaders, documentName, connectionConfig }) {
      try {
        const decision = await authorizeCollabConnection(
          cookies,
          requestHeaders.get("cookie"),
          documentName,
        );
        connectionConfig.readOnly = decision.readOnly;
        return decision.context;
      } catch (error) {
        if (!(error instanceof CollabAuthError)) {
          app.log.error({ err: error, documentName }, "collab authentication failed");
        }
        throw error instanceof CollabAuthError ? error : new CollabAuthError("forbidden");
      }
    },
  });

  // Same wiring as Hocuspocus's own Server, but on Fastify's HTTP server so
  // REST, the SPA and /collab share one port and one origin.
  const ws = crossws({
    hooks: {
      open(peer) {
        const connection = hocuspocus.handleConnection(
          peer.websocket as unknown as WebSocketLike,
          peer.request as Request,
        );
        (peer as unknown as { collab: typeof connection }).collab = connection;
        (peer.websocket as unknown as { on?: (event: string, cb: () => void) => void }).on?.(
          "pong",
          () => connection.touch(),
        );
      },
      message(peer, message) {
        (
          peer as unknown as { collab?: { handleMessage(data: Uint8Array): void } }
        ).collab?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        (
          peer as unknown as {
            collab?: { handleClose(event: { code?: number; reason?: string }): void };
          }
        ).collab?.handleClose({ code: event.code, reason: event.reason });
      },
      error(peer, error) {
        app.log.warn({ err: error, peer: peer.id }, "collab websocket error");
      },
    },
  });

  app.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== COLLAB_PATH) {
      rejectUpgrade(socket, "404 Not Found");
      return;
    }
    if (!isSameOrigin(request)) {
      rejectUpgrade(socket, "403 Forbidden");
      return;
    }
    void ws.handleUpgrade(request, socket, head);
  });

  // Close the WebSockets themselves (code 1001 "going away"): Node's
  // server.close() waits for upgraded sockets too, and hocuspocus's
  // closeConnections() only closes per-document connections, leaving sockets
  // open — shutdown would hang for as long as any client stayed connected.
  // Each socket close runs the last-disconnect path (store + unload); wait,
  // bounded, for that. This must be preClose: onClose hooks only run after
  // the HTTP server has finished closing, which is what these open sockets
  // block — a deadlock.
  app.addHook("preClose", async () => {
    ws.closeAll(1001, "server shutting down");
    const deadline = Date.now() + 5_000;
    while (hocuspocus.getDocumentsCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });

  app.decorate("collab", hocuspocus);
}
