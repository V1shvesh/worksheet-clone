import type { AuthUser, LoginInput, SignupInput } from "@worksheet-clone/shared";
import { api } from "../../app/api";
import { clearUserCaches } from "../../crdt/offlineCache";

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
      onQueryStarted: async (_arg, { dispatch, getState, queryFulfilled }) => {
        await queryFulfilled;
        // The on-device workbook copies belong to this user: the next one must not find them.
        // Not awaited: a deletion waits for open connections to close and must not stall logout.
        const userId = authApi.endpoints.me.select()(getState() as ApiState).data?.user.id;
        if (userId) void clearUserCaches(userId);
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

// Only the api slice matters to `select`; naming RootState here would make the store and this file import each other.
type ApiState = Parameters<ReturnType<typeof authApi.endpoints.me.select>>[0];

export const { useMeQuery, useSignupMutation, useLoginMutation, useLogoutMutation } = authApi;
