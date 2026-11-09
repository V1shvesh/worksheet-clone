import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Hocuspocus, type Extension, type WebSocketLike } from "@hocuspocus/server";
import crossws from "crossws/adapters/node";
import type { FastifyInstance } from "fastify";
import { clientAddress, TokenBucketLimiter } from "../http/rate-limits.js";
import { originMatchesHost } from "../http/same-origin.js";
import { LIMITS } from "@worksheet-clone/shared";
import { SESSION_COOKIE_NAME } from "../http/session.js";
import { authorizeCollabConnection, CollabAuthError, type CollabContext } from "./auth.js";

export const COLLAB_PATH = "/collab";
const SHUTDOWN_BOUND_MS = 5_000;

interface ShutdownFlush {
  unsavedDocuments(): string[];
  flushForShutdown(): Promise<string[]>;
}

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
  return Boolean(origin && host && originMatchesHost(origin, host));
}

function rejectUpgrade(
  socket: Duplex,
  status: string,
  headers: Record<string, string | number> = {},
): void {
  const extra = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n${extra.join("")}\r\n`);
  socket.destroy();
}

export function mountCollab(
  app: FastifyInstance,
  extensions: Extension[] = [],
  options: {
    wsMessageBytes?: number;
    /** Per-IP limit on upgrade attempts (a burst of perMinute, refilling perMinute per minute). */
    wsUpgrade?: { perMinute: number; trustProxy: boolean | number };
  } = {},
): void {
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
        app.log.info(
          {
            workbookId: documentName,
            userId: decision.context.userId,
            role: decision.context.role,
          },
          "collab connection authorized",
        );
        return decision.context;
      } catch (error) {
        if (error instanceof CollabAuthError) {
          app.log.info(
            { workbookId: documentName, userId: error.userId, reason: error.reason },
            "collab connection refused",
          );
        } else {
          app.log.error({ err: error, workbookId: documentName }, "collab authentication failed");
        }
        throw error instanceof CollabAuthError ? error : new CollabAuthError("forbidden");
      }
    },
  });

  // Same wiring as Hocuspocus's own Server, but on Fastify's HTTP server so
  // REST, the SPA and /collab share one port and one origin.
  const ws = crossws({
    // ws closes a socket whose message exceeds this with 1009 (message too big)
    // before the frame is buffered in full.
    serverOptions: { maxPayload: options.wsMessageBytes ?? LIMITS.wsMessageBytes },
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

  const upgradeLimiter = options.wsUpgrade
    ? new TokenBucketLimiter(options.wsUpgrade.perMinute, options.wsUpgrade.perMinute)
    : undefined;

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
    if (upgradeLimiter && options.wsUpgrade) {
      const verdict = upgradeLimiter.take(clientAddress(request, options.wsUpgrade.trustProxy));
      if (!verdict.allowed) {
        rejectUpgrade(socket, "429 Too Many Requests", {
          "Retry-After": verdict.retryAfterSeconds,
        });
        return;
      }
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
  // A document whose store keeps failing stays in memory (persistence.ts), so
  // it never reaches zero: stop waiting for those, give each one last store
  // attempt, and say loudly what could not be saved. Bounded either way.
  const persistence = extensions.find(
    (extension): extension is Extension & ShutdownFlush =>
      typeof (extension as Partial<ShutdownFlush>).flushForShutdown === "function",
  );
  app.addHook("preClose", async () => {
    ws.closeAll(1001, "server shutting down");
    const deadline = Date.now() + SHUTDOWN_BOUND_MS;
    const stuck = () => new Set(persistence?.unsavedDocuments() ?? []);
    const settling = () => [...hocuspocus.documents.keys()].filter((name) => !stuck().has(name));
    while (settling().length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (persistence && persistence.unsavedDocuments().length > 0) {
      const remaining = Math.max(deadline - Date.now(), 1_000);
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const lost = await Promise.race([
        persistence.flushForShutdown(),
        new Promise<string[]>((resolve) => {
          giveUp = setTimeout(() => resolve(persistence.unsavedDocuments()), remaining);
        }),
      ]);
      clearTimeout(giveUp);
      for (const workbookId of lost) {
        app.log.error(
          { workbookId },
          "shutting down with UNSAVED changes: the database kept refusing this workbook's document",
        );
      }
    }
  });

  app.decorate("collab", hocuspocus);
}
