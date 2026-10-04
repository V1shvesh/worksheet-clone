import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";
import type { ApiErrorBody, AuthUser, LoginInput, SignupInput } from "@worksheet-clone/shared";

export const authApi = createApi({
  reducerPath: "authApi",
  baseQuery: fetchBaseQuery({ baseUrl: "/api/auth", credentials: "include" }),
  endpoints: (builder) => ({
    signup: builder.mutation<{ user: AuthUser }, SignupInput>({
      query: (body) => ({ url: "/signup", method: "POST", body }),
    }),
    login: builder.mutation<{ user: AuthUser }, LoginInput>({
      query: (body) => ({ url: "/login", method: "POST", body }),
    }),
    logout: builder.mutation<{ ok: true }, void>({
      query: () => ({ url: "/logout", method: "POST" }),
    }),
    me: builder.query<{ user: AuthUser }, void>({
      query: () => "/me",
    }),
  }),
});

export const { useSignupMutation, useLoginMutation, useLogoutMutation, useMeQuery } = authApi;

export function isApiErrorBody(data: unknown): data is ApiErrorBody {
  return (
    typeof data === "object" &&
    data !== null &&
    "error" in data &&
    typeof (data as ApiErrorBody).error?.message === "string"
  );
}

export function getAuthErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (isApiErrorBody(data)) {
      return data.error.message;
    }
  }
  return "Something went wrong. Please try again.";
}
