import type { FastifyError, FastifyInstance, FastifyReply } from "fastify";
import type { ApiErrorCode } from "@worksheet-clone/shared";
import { DomainError } from "../domain/errors.js";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  USER_NOT_FOUND: 404,
  ALREADY_MEMBER: 409,
  INVALID_MEMBER_OPERATION: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

export function sendApiError(reply: FastifyReply, code: ApiErrorCode, message: string): void {
  void reply.code(STATUS_BY_CODE[code]).send({ error: { code, message } });
}

// Structural so the server needn't import zod itself (and risk a second zod
// copy under injectWorkspacePackages breaking instanceof checks).
interface SafeParser<T> {
  safeParse(
    data: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

export function parseOrThrow<T>(
  schema: SafeParser<T>,
  data: unknown,
  code: ApiErrorCode = "VALIDATION_ERROR",
): T {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }
  const issue = result.error.issues[0];
  const field = issue?.path.map(String).join(".");
  const message = issue ? (field ? `${field}: ${issue.message}` : issue.message) : "Invalid input";
  throw new DomainError(code, code === "NOT_FOUND" ? "Not found" : message);
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof DomainError) {
      sendApiError(reply, error.code, error.message);
      return;
    }

    const status = error.statusCode ?? 500;
    if (status === 429) {
      sendApiError(reply, "RATE_LIMITED", "Too many attempts. Please wait and try again.");
      return;
    }
    if (status >= 400 && status < 500) {
      sendApiError(reply, "VALIDATION_ERROR", error.message);
      return;
    }

    request.log.error({ err: error }, "unhandled error");
    sendApiError(reply, "INTERNAL_ERROR", "Something went wrong");
  });
}
