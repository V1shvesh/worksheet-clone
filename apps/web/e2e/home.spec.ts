import { expect, test } from "@playwright/test";

test("home page loads and shows the app heading", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Worksheet Clone" })).toBeVisible();
});
