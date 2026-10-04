import { expect, test } from "@playwright/test";

test.describe("auth", () => {
  test("redirects an unauthenticated visitor from / to /login", async ({ page }) => {
    await page.route("**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Not logged in" } }),
      });
    });

    await page.goto("/");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Log in" })).toBeVisible();
  });

  test("signs up, then lands on the signed-in home page", async ({ page }) => {
    const email = "new-user@example.com";

    await page.route("**/api/auth/signup", async (route) => {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ user: { id: "1", email } }),
      });
    });
    await page.route("**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: { id: "1", email } }),
      });
    });

    await page.goto("/signup");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("correct-password");
    await page.getByRole("button", { name: "Sign up" }).click();

    await expect(page).toHaveURL("/");
    await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  });

  test("logs in with the right password", async ({ page }) => {
    const email = "existing-user@example.com";

    await page.route("**/api/auth/login", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: { id: "1", email } }),
      });
    });
    await page.route("**/api/auth/me", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ user: { id: "1", email } }),
      });
    });

    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("correct-password");
    await page.getByRole("button", { name: "Log in" }).click();

    await expect(page).toHaveURL("/");
    await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  });

  test("shows an error message on the wrong password without navigating away", async ({ page }) => {
    await page.route("**/api/auth/login", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "INVALID_CREDENTIALS", message: "Invalid email or password" },
        }),
      });
    });

    await page.goto("/login");
    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByLabel("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Log in" }).click();

    await expect(page.getByRole("alert")).toHaveText("Invalid email or password");
    await expect(page).toHaveURL(/\/login$/);
  });
});
