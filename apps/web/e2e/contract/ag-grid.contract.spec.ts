import { expect, test } from "@playwright/test";
import { gridViewContract } from "../../src/features/grid/port/contract";

test.beforeEach(async ({ page }) => {
  await page.exposeFunction("__mouseClick", (x: number, y: number) => page.mouse.click(x, y));
  await page.exposeFunction("__keyPress", (key: string) => page.keyboard.press(key));
  await page.goto("/e2e/harness/grid-contract.html");
  await page.waitForFunction(() => "__contract" in window);
});

test("the harness lists exactly the contract cases", async ({ page }) => {
  const names = await page.evaluate(() => window.__contract.listCases());
  expect(names).toEqual(gridViewContract.map((c) => c.name));
});

for (const { name } of gridViewContract) {
  test(`AgGridView: ${name}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.evaluate((n) => window.__contract.runCase(n), name);
    expect(errors).toEqual([]);
  });
}
