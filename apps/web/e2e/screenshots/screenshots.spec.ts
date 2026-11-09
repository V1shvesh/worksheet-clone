import { expect, test, type Page } from "@playwright/test";
import { GridPage } from "../pages/grid-page";
import { SheetTabsPage } from "../pages/sheet-tabs-page";

/**
 * Builds a small realistic workbook on a RUNNING stack (`pnpm docker:up`) and writes the README
 * screenshots to docs/screenshots. Run with `pnpm screenshots`. Uses 2 signups (limit: 5 per
 * hour per IP, in memory): restart the app container between runs if needed.
 */
const run = Date.now().toString(36);
const password = "screenshot-password-1";
const alice = `alice-${run}@example.com`;
const bob = `bob-${run}@example.com`;
const name = "Household budget";
const out = "../../docs/screenshots";

const rows: (string | number)[][] = [
  ["Category", "Q1", "Q2", "Q3", "Q4", "Total"],
  ["Rent", 3600, 3600, 3600, 3900, "=SUM(B2:E2)"],
  ["Groceries", 1250, 1310, 1190, 1480, "=SUM(B3:E3)"],
  ["Software", 240, 240, 310, 310, "=SUM(B4:E4)"],
  ["Travel", 400, 1250, 2100, 800, "=SUM(B5:E5)"],
  ["Utilities", 410, 360, 330, 450, "=SUM(B6:E6)"],
  ["Total", "=SUM(B2:B6)", "=SUM(C2:C6)", "=SUM(D2:D6)", "=SUM(E2:E6)", "=SUM(F2:F6)"],
];

async function auth(page: Page, path: "/signup" | "/login", email: string) {
  await page.goto(path);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: path === "/signup" ? "Sign up" : "Log in" }).click();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
}

test("README screenshots", async ({ browser }) => {
  test.setTimeout(120_000);
  const viewport = { width: 1280, height: 800 };
  const light = await browser.newContext({ viewport, colorScheme: "light" });
  const bobCtx = await browser.newContext({ viewport, colorScheme: "light" });
  const a = await light.newPage();
  const b = await bobCtx.newPage();

  await auth(b, "/signup", bob);
  await auth(a, "/signup", alice);
  await a.getByLabel("New workbook name").fill(name);
  await a.getByRole("button", { name: "Create workbook" }).click();
  await expect(a.getByRole("link", { name })).toBeVisible();
  await a.getByLabel("New workbook name").fill("Roadmap 2027");
  await a.getByRole("button", { name: "Create workbook" }).click();
  await expect(a.getByRole("link", { name: "Roadmap 2027" })).toBeVisible();

  await a.getByRole("button", { name: `Members of ${name}` }).click();
  const dialog = a.getByRole("dialog");
  const form = dialog.getByRole("form", { name: "Add a person" });
  await form.getByLabel("Email").fill(bob);
  await form.getByRole("button", { name: "Add" }).click();
  await dialog.getByLabel(`Role for ${bob}`).selectOption("editor");
  await dialog.getByRole("button", { name: "Close" }).click();
  await a.screenshot({ path: `${out}/workbooks.png` });

  await a.getByRole("link", { name: name }).click();
  const grid = new GridPage(a);
  const tabs = new SheetTabsPage(a);
  await expect(a.getByRole("status", { name: "Connection" })).toContainText("All changes saved");
  await expect(grid.cell(0, 0)).toBeVisible();
  const first = (await tabs.names())[0]!;
  await tabs.rename(first, "Budget");

  for (const [r, row] of rows.entries()) {
    for (const [c, value] of row.entries()) await grid.typeInto(r, c, String(value));
  }
  // Header row and total row: bold; header gets a fill.
  await grid.dragSelect([0, 0], [0, 5]);
  await grid.toolbarButton("Bold").click();
  await grid.pickFillColor("Yellow");
  await grid.dragSelect([6, 0], [6, 5]);
  await grid.toolbarButton("Bold").click();

  await tabs.add();
  await expect(tabs.tabs()).toHaveCount(2);
  await tabs.rename((await tabs.names())[1]!, "Summary");
  await grid.typeInto(0, 0, "Annual");
  await grid.typeInto(0, 1, "=Budget!F7");
  await grid.typeInto(1, 0, "Per month");
  await grid.typeInto(1, 1, "=ROUND(B1/12,2)");
  await grid.typeInto(2, 0, "Travel share");
  await grid.typeInto(2, 1, "=ROUND(Budget!F5/B1,3)");
  await grid.dragSelect([0, 0], [0, 0]);
  await grid.toolbarButton("Bold").click();
  await expect(grid.cell(0, 1)).not.toHaveText("");
  await tabs.open("Budget");

  // Bob joins and parks his cursor on an empty cell next to the table.
  await b.reload();
  await b.getByRole("link", { name }).click();
  const gb = new GridPage(b);
  await expect(gb.cell(2, 6)).toBeVisible();
  await gb.clickCell(2, 6);
  await expect(grid.remoteCursor()).toHaveCount(1);
  await grid.clickCell(6, 5);
  await a.waitForTimeout(500);
  await a.screenshot({ path: `${out}/budget-light.png` });

  await tabs.open("Summary");
  await grid.clickCell(0, 1);
  await a.waitForTimeout(300);
  await a.screenshot({ path: `${out}/summary-formula.png` });

  // The workbook list with the members dialog in dark mode (the grid itself has no dark theme yet).
  const dark = await browser.newContext({ viewport, colorScheme: "dark" });
  const d = await dark.newPage();
  await auth(d, "/login", alice);
  await d.getByRole("button", { name: `Members of ${name}` }).click();
  await expect(d.getByRole("dialog").getByText(bob)).toBeVisible();
  await d.screenshot({ path: `${out}/members-dark.png` });

  await dark.close();
  await bobCtx.close();
  await light.close();
});
