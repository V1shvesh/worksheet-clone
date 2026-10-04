import { useLogoutMutation, useMeQuery } from "../features/auth/authApi";

export function HomePage() {
  const { data } = useMeQuery();
  const [logout] = useLogoutMutation();

  return (
    <main>
      <h1>Worksheet Clone</h1>
      {data && <p>Signed in as {data.user.email}</p>}
      <button type="button" onClick={() => void logout()}>
        Log out
      </button>
    </main>
  );
}
