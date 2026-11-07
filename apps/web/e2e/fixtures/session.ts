import type { Page } from "@playwright/test";
import type { AuthUser } from "@worksheet-clone/shared";

export function json(status: number, body: unknown) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

// Stateful stand-in for the auth endpoints: /me answers from the current
// session, and login/signup/logout change it — so specs exercise the same
// 401 -> 200 -> 401 transitions a real server would produce.
export async function mockSession(page: Page, initialUser: AuthUser | null) {
  let user = initialUser;

  await page.route("**/api/auth/me", (route) =>
    route.fulfill(
      user
        ? json(200, { user })
        : json(401, { error: { code: "UNAUTHORIZED", message: "Not logged in" } }),
    ),
  );
  for (const action of ["login", "signup"] as const) {
    await page.route(`**/api/auth/${action}`, (route) => {
      const body = route.request().postDataJSON() as { email: string };
      user = { id: "00000000-0000-4000-8000-000000000001", email: body.email };
      return route.fulfill(json(action === "signup" ? 201 : 200, { user }));
    });
  }
  await page.route("**/api/auth/logout", (route) => {
    user = null;
    return route.fulfill(json(200, { ok: true }));
  });

  return {
    get user() {
      return user;
    },
  };
}
