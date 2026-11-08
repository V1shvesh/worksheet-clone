import { expect, test, type Page } from "@playwright/test";
import { mockCollab } from "./fixtures/collab";
import { json, mockApiFallback, mockSession } from "./fixtures/session";
import { me, mockWorkbooks, workbook } from "./fixtures/workbooks";

const workbookId = "00000000-0000-4000-8000-000000000031";

async function setup(page: Page, collab: { acceptDelayMs?: number } = {}) {
  await mockApiFallback(page);
  await mockSession(page, me);
  await mockWorkbooks(page, [workbook(workbookId, "Q3 budget", "owner")]);
  await mockCollab(page, { access: "read-write", ...collab });
}

const waking = (page: Page) => page.getByTestId("waking-up");

test("REST that is slow to answer shows 'Waking up the server…' until it does", async ({
  page,
}) => {
  await setup(page);
  // Registered last, so it runs first; hands over to the mock after 3 s.
  await page.route("**/api/auth/me", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.fallback();
  });
  await page.goto(`/workbooks/${workbookId}`);

  await expect(waking(page)).toHaveText("Waking up the server…", { timeout: 2500 });
  await expect(page.getByRole("heading", { name: "Q3 budget" })).toBeVisible({ timeout: 6000 });
  await expect(waking(page)).toBeHidden();
});

test("a socket that is slow to accept shows the message, then the workbook", async ({ page }) => {
  await setup(page, { acceptDelayMs: 3500 });
  await page.goto(`/workbooks/${workbookId}`);

  await expect(page.getByRole("heading", { name: "Q3 budget" })).toBeVisible();
  await expect(waking(page)).toBeHidden(); // not before the 2 s threshold
  await expect(waking(page)).toHaveText("Waking up the server…", { timeout: 3000 });
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText("All changes saved", {
    timeout: 8000,
  });
  await expect(waking(page)).toBeHidden();
});

test("a 503 from a sleeping server is retried and the page loads", async ({ page }) => {
  await setup(page);
  let attempts = 0;
  await page.route("**/api/auth/me", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      return route.fulfill(json(503, { error: { code: "UNAVAILABLE", message: "Starting" } }));
    }
    await route.fallback();
  });
  await page.goto(`/workbooks/${workbookId}`);

  await expect(page.getByRole("heading", { name: "Q3 budget" })).toBeVisible();
  expect(attempts).toBe(2);
  await expect(page).toHaveURL(new RegExp(`/workbooks/${workbookId}`)); // not bounced to /login
});
