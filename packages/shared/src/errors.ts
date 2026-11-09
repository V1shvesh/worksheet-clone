export const apiErrorCodes = [
  "VALIDATION_ERROR",
  "EMAIL_TAKEN",
  "INVALID_CREDENTIALS",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "FORBIDDEN",
  "USER_NOT_FOUND",
  "ALREADY_MEMBER",
  "INVALID_MEMBER_OPERATION",
  "RATE_LIMITED",
  "UNSUPPORTED_MEDIA_TYPE",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof apiErrorCodes)[number];

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}
