import type { FastifyServerOptions } from "fastify";

// Anything that could carry a session: the request/response header maps and a
// bare `headers` or `cookie` field on any log object. Fastify's default
// serializers already omit headers; this is the backstop for a handler that
// logs a request or header map directly.
/**
 * What to log about a failed database call. Drizzle's error message embeds the query
 * parameters, i.e. the whole binary document or a session id, so only the
 * driver's cause is logged: its Postgres code and first message line.
 */
export function describeDbError(error: unknown): {
  name: string;
  code?: string;
  reason: string;
} {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  const { name, code, message } = (cause ?? {}) as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return {
    name: typeof name === "string" ? name : "Error",
    ...(typeof code === "string" ? { code } : {}),
    reason: (typeof message === "string" ? message : "unknown error").split("\n")[0]!.slice(0, 200),
  };
}

export const LOG_REDACT_PATHS = [
  "req.headers.cookie",
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  "headers.cookie",
  'headers["set-cookie"]',
  "cookie",
  "*.cookie",
  "*.headers.cookie",
  'requestHeaders["cookie"]',
];

// Unexpected DB errors reach the logger from many places (the REST error
// handler, collab auth). A Drizzle query error would print its parameters —
// session ids, emails, document bytes — so such errors are always reduced to
// the driver's cause.
function isQueryError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { query?: unknown }).query === "string" &&
    "params" in error
  );
}

function serializeError(error: Error): {
  [key: string]: unknown;
  type: string;
  message: string;
  stack: string;
} {
  if (isQueryError(error)) {
    const { name, code, reason } = describeDbError(error);
    // No stack: its first line is the full message, parameters included.
    return { type: name, message: reason, stack: "", ...(code ? { code } : {}) };
  }
  return { type: error.name, message: error.message, stack: error.stack ?? "" };
}

export function buildLoggerOptions(stream?: {
  write(message: string): void;
}): Exclude<FastifyServerOptions["logger"], boolean | undefined> {
  return {
    serializers: { err: serializeError },
    redact: { paths: LOG_REDACT_PATHS, censor: "[Redacted]" },
    ...(stream ? { stream } : {}),
  };
}
