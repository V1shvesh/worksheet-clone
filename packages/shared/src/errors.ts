export const apiErrorCodes = [
  "VALIDATION_ERROR",
  "EMAIL_TAKEN",
  "INVALID_CREDENTIALS",
  "UNAUTHORIZED",
  "NOT_FOUND",
] as const;

export type ApiErrorCode = (typeof apiErrorCodes)[number];

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}
