import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import WebSocket from "ws";
import * as Y from "yjs";

export type ConnectOutcome =
  { kind: "synced"; scope: string | undefined } | { kind: "denied"; reason: string };

export interface CollabClient {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  outcome: Promise<ConnectOutcome>;
  closed: Promise<{ code: number }>;
  destroy: () => void;
}

// Node's built-in WebSocket can't set a Cookie header; `ws` can. The
// provider constructs its socket with only a URL, so bake headers in.
function webSocketWithHeaders(headers: Record<string, string>) {
  return class extends WebSocket {
    constructor(url: string) {
      super(url, { headers });
    }
  };
}

export function connectCollab(options: {
  baseUrl: string;
  workbookId: string;
  cookie?: string;
  origin?: string;
  doc?: Y.Doc;
}): CollabClient {
  const doc = options.doc ?? new Y.Doc();
  const url = `${options.baseUrl.replace(/^http/, "ws")}/collab`;
  const headers: Record<string, string> = { origin: options.origin ?? options.baseUrl };
  if (options.cookie) {
    headers.cookie = options.cookie;
  }

  let resolveOutcome!: (outcome: ConnectOutcome) => void;
  const outcome = new Promise<ConnectOutcome>((resolve) => (resolveOutcome = resolve));
  let resolveClosed!: (event: { code: number }) => void;
  const closed = new Promise<{ code: number }>((resolve) => (resolveClosed = resolve));

  const socket = new HocuspocusProviderWebsocket({
    url,
    WebSocketPolyfill: webSocketWithHeaders(headers),
  });
  const provider: HocuspocusProvider = new HocuspocusProvider({
    websocketProvider: socket,
    name: options.workbookId,
    document: doc,
    onSynced: () => resolveOutcome({ kind: "synced", scope: provider.authorizedScope }),
    onAuthenticationFailed: ({ reason }) => resolveOutcome({ kind: "denied", reason }),
    onClose: ({ event }) => resolveClosed({ code: event.code }),
  });
  // A supplied websocketProvider isn't managed by the provider: attach and
  // destroy it ourselves.
  provider.attach();

  return {
    doc,
    provider,
    outcome,
    closed,
    destroy: () => {
      provider.destroy();
      socket.destroy();
    },
  };
}

export async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
