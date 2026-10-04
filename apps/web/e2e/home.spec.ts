import { expect, test } from "@playwright/test";

test("home page loads and shows the app heading when signed in", async ({ page }) => {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: { id: "1", email: "user@example.com" } }),
    });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Worksheet Clone" })).toBeVisible();
});
