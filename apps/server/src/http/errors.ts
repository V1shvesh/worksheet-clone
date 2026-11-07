import type { FastifyReply } from "fastify";
import type { ApiErrorCode } from "@worksheet-clone/shared";

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
};

export function sendApiError(reply: FastifyReply, code: ApiErrorCode, message: string): void {
  void reply.code(STATUS_BY_CODE[code]).send({ error: { code, message } });
}
