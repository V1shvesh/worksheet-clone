import type { ApiErrorCode } from "@worksheet-clone/shared";

export class DomainError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
