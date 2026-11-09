import type { FastifyInstance } from "fastify";
import { sendApiError } from "./errors.js";
import { originMatchesHost } from "./same-origin.js";

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isJson(contentType: string): boolean {
  return /^application\/json\s*(;|$)/i.test(contentType.trim());
}

/**
 * CSRF defence for cookie-authenticated REST calls, on top of the session
 * cookie being SameSite=Lax (which already stops cross-site POSTs in current browsers).
 *
 * For POST/PUT/PATCH/DELETE under /api:
 * - If an Origin header is present its host must equal Host (403 FORBIDDEN).
 *   Browsers always send Origin on cross-origin unsafe requests; requests without
 *   it (curl, server-to-server, tests) carry no ambient browser cookies to abuse.
 * - A Content-Type, when sent, must be application/json (415). That rules out the
 *   "simple" form encodings (urlencoded, multipart, text/plain) a cross-site <form>
 *   can send. A body-less request (logout, delete) may omit it; a request with a
 *   body and no Content-Type is rejected too.
 *
 * Runs in onRequest, before body parsing, so nothing is read or parsed first.
 */
export function registerCsrfProtection(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!UNSAFE_METHODS.has(request.method) || !request.url.startsWith("/api/")) {
      return;
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !originMatchesHost(origin, request.headers.host ?? "")) {
      sendApiError(reply, "FORBIDDEN", "Cross-origin request refused");
      return reply;
    }

    const contentType = request.headers["content-type"];
    const hasBody =
      request.headers["transfer-encoding"] !== undefined ||
      Number(request.headers["content-length"] ?? 0) > 0;
    if (contentType === undefined ? hasBody : !isJson(contentType)) {
      sendApiError(reply, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
      return reply;
    }
  });
}
