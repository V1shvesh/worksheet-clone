import type { ApiErrorBody } from "@worksheet-clone/shared";

export function isApiErrorBody(data: unknown): data is ApiErrorBody {
  return (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof (data as ApiErrorBody).error?.message === "string"
  );
}

export function getApiErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (isApiErrorBody(data)) {
      return data.error.message;
    }
  }
  return "Something went wrong. Please try again.";
}
