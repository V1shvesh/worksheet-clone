import { expect, test } from "@playwright/test";
import { mockApiFallback, mockSession } from "./fixtures/session";
import { me, mockWorkbooks, workbook } from "./fixtures/workbooks";

const budget = workbook("00000000-0000-4000-8000-000000000011", "Budget", "owner");
const roadmap = workbook("00000000-0000-4000-8000-000000000012", "Roadmap", "viewer");

test.beforeEach(async ({ page }) => {
  await mockApiFallback(page);
  await mockSession(page, me);
});

test("lists owned and shared workbooks and creates a new one", async ({ page }) => {
  await mockWorkbooks(page, [budget, roadmap]);
  await page.goto("/");

  const mine = page.getByRole("region", { name: "My workbooks" });
  const shared = page.getByRole("region", { name: "Shared with me" });
  await expect(mine.getByRole("link", { name: "Budget" })).toBeVisible();
  await expect(shared.getByRole("listitem")).toContainText("Roadmap (viewer)");

  await page.getByLabel("New workbook name").fill("Q4 forecast");
  await page.getByRole("button", { name: "Create workbook" }).click();
  await expect(mine.getByRole("link", { name: "Q4 forecast" })).toBeVisible();
  await expect(page.getByLabel("New workbook name")).toHaveValue("");
});

test("deletes a workbook only after confirming", async ({ page }) => {
  await mockWorkbooks(page, [budget]);
  await page.goto("/");

  await page.getByRole("button", { name: "Delete Budget" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("link", { name: "Budget" })).toBeVisible();

  await page.getByRole("button", { name: "Delete Budget" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "Delete Budget" }).click();
  await page.getByRole("button", { name: "Delete workbook" }).click();
  await expect(page.getByText("You don't have any workbooks yet.")).toBeVisible();
});

test("owner manages members: add, reject unknown email, change role, remove", async ({ page }) => {
  await mockWorkbooks(page, [budget], ["bob@example.com"]);
  await page.goto("/");
  await page.getByRole("button", { name: "Members of Budget" }).click();

  const dialog = page.getByRole("dialog", { name: 'People with access to "Budget"' });
  const form = dialog.getByRole("form", { name: "Add a person" });
  await form.getByLabel("Email").fill("ghost@example.com");
  await form.getByRole("button", { name: "Add" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("No account exists with that email");

  await form.getByLabel("Email").fill("bob@example.com");
  await form.getByRole("button", { name: "Add" }).click();
  const bobRole = dialog.getByLabel("Role for bob@example.com");
  await expect(bobRole).toHaveValue("viewer");
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  await bobRole.selectOption("editor");
  await expect(bobRole).toHaveValue("editor");

  await dialog.getByRole("button", { name: "Remove bob@example.com" }).click();
  await expect(dialog.getByText("bob@example.com")).toHaveCount(0);
  await expect(dialog.getByRole("listitem")).toHaveCount(1);
});

test("a viewer can open a shared workbook but not delete or manage it", async ({ page }) => {
  await mockWorkbooks(page, [roadmap]);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "Delete Roadmap" })).toHaveCount(0);

  await page.getByRole("button", { name: "Members of Roadmap" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await expect(dialog.getByRole("form", { name: "Add a person" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("link", { name: "Roadmap" }).click();
  await expect(page.getByRole("heading", { name: "Roadmap" })).toBeVisible();
  await expect(page.getByText("Your role: viewer")).toBeVisible();
});

test("an unknown workbook id shows not found", async ({ page }) => {
  await mockWorkbooks(page, []);
  await page.goto("/workbooks/00000000-0000-4000-8000-000000000099");
  await expect(page.getByRole("alert")).toHaveText("Workbook not found");
});

test("logging out and in as someone else never shows the previous user's workbooks", async ({
  page,
}) => {
  await mockWorkbooks(page, [budget]);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Budget" })).toBeVisible();

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  let listedAfterRelogin = false;
  await page.route("**/api/workbooks", (route) => {
    listedAfterRelogin = true;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ workbooks: [] }),
    });
  });
  await page.getByLabel("Email").fill("someone-else@example.com");
  await page.getByLabel("Password").fill("correct-password");
  await page.getByRole("button", { name: "Log in" }).click();

  await expect(page.getByText("Signed in as someone-else@example.com")).toBeVisible();
  await expect(page.getByText("You don't have any workbooks yet.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Budget" })).toHaveCount(0);
  expect(listedAfterRelogin).toBe(true);
});
