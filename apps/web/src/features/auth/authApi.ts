import type { AuthUser, LoginInput, SignupInput } from "@worksheet-clone/shared";
import { api } from "../../app/api";

type AuthResponse = { user: AuthUser };

export const authApi = api.injectEndpoints({
  endpoints: (builder) => ({
    me: builder.query<AuthResponse, void>({
      query: () => "/auth/me",
    }),
    signup: builder.mutation<AuthResponse, SignupInput>({
      query: (body) => ({ url: "/auth/signup", method: "POST", body }),
      onQueryStarted: (_arg, { dispatch, queryFulfilled }) =>
        startSession(dispatch, queryFulfilled),
    }),
    login: builder.mutation<AuthResponse, LoginInput>({
      query: (body) => ({ url: "/auth/login", method: "POST", body }),
      onQueryStarted: (_arg, { dispatch, queryFulfilled }) =>
        startSession(dispatch, queryFulfilled),
    }),
    logout: builder.mutation<{ ok: true }, void>({
      query: () => ({ url: "/auth/logout", method: "POST" }),
      // Dropping every cached response (including /me) sends RequireAuth back
      // to the server, which now says 401 and redirects to /login — and the
      // next user can never see this user's cached workbooks.
      onQueryStarted: async (_arg, { dispatch, queryFulfilled }) => {
        await queryFulfilled;
        dispatch(api.util.resetApiState());
      },
    }),
  }),
});

// A previous visit may have cached /me as a 401; replace the whole cache with
// the freshly signed-in user so RequireAuth doesn't bounce back to /login.
async function startSession(
  dispatch: (action: unknown) => unknown,
  queryFulfilled: Promise<{ data: AuthResponse }>,
): Promise<void> {
  try {
    const { data } = await queryFulfilled;
    dispatch(api.util.resetApiState());
    dispatch(authApi.util.upsertQueryData("me", undefined, data));
  } catch {
    // The page shows the error from the mutation result itself.
  }
}

export const { useMeQuery, useSignupMutation, useLoginMutation, useLogoutMutation } = authApi;
