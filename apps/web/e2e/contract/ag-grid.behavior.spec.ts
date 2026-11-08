// Adapter behavior the shared contract does not cover: gestures AG Grid owns (column move and
// resize), the DOM attributes the future GridPage page object relies on, and key handling.
import { expect, test, type Page } from "@playwright/test";

async function mountGrid(page: Page): Promise<void> {
  await page.goto("/e2e/harness/grid-contract.html");
  await page.waitForFunction(() => "__contract" in window);
  await page.evaluate(() => window.__demo.mount());
}

const recorded = (page: Page) => page.evaluate(() => window.__demo.events);

test("every cell has one gridcell role and one data-row/data-col pair; headers are distinguishable", async ({
  page,
}) => {
  await mountGrid(page);
  const cells = page.locator('#grid [role="gridcell"]');
  const withCoords = page.locator("#grid [data-row][data-col]");
  expect(await cells.count()).toBeGreaterThan(20);
  expect(await withCoords.count()).toBe(await cells.count());
  await expect(page.locator('#grid [role="gridcell"] [role="gridcell"]')).toHaveCount(0);
  await expect(page.locator('#grid [data-row-header="0"]')).toHaveText("1");
  await expect(page.locator('#grid [data-col-header="2"]')).toHaveText("C2");
  await expect(page.locator("#grid [data-corner]")).toHaveCount(1);
});

test("renders text, error styling and formats", async ({ page }) => {
  await mountGrid(page);
  const formatted = page.locator('#grid [data-row="0"][data-col="0"] > div');
  await expect(formatted).toHaveText("r0c0");
  await expect(formatted).toHaveCSS("background-color", "rgb(255, 255, 0)");
  await expect(formatted).toHaveCSS("font-weight", "700");
  await expect(formatted).toHaveCSS("font-style", "italic");
  await expect(formatted).toHaveCSS("text-decoration-line", "underline");
  await expect(page.locator('#grid [data-row="1"][data-col="0"] > div')).toHaveCSS(
    "color",
    "rgb(192, 57, 43)",
  );
});

test("dragging a column header emits columnMoveRequested and restores AG Grid's order", async ({
  page,
}) => {
  await mountGrid(page);
  const header = (await page.locator('[data-col-header="1"]').boundingBox())!;
  await page.mouse.move(header.x + 20, header.y + 8);
  await page.mouse.down();
  await page.mouse.move(header.x + 100, header.y + 8, { steps: 5 });
  await page.mouse.move(header.x + 230, header.y + 8, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => recorded(page)).toEqual([["columnMoveRequested", 1, 3]]);
  const order = await page
    .locator("#grid .ag-header-cell")
    .evaluateAll((els) => els.slice(0, 5).map((e) => e.getAttribute("col-id")));
  expect(order).toEqual(["rowHeader", "c0", "c1", "c2", "c3"]);
});

test("the row-header column cannot be moved and resizing emits columnResized, never rowResized", async ({
  page,
}) => {
  await mountGrid(page);
  const corner = (await page.locator("#grid [data-corner]").boundingBox())!;
  await page.mouse.move(corner.x + 10, corner.y + 8);
  await page.mouse.down();
  await page.mouse.move(corner.x + 150, corner.y + 8, { steps: 8 });
  await page.mouse.up();
  expect(await recorded(page)).toEqual([]);

  const handle = (await page
    .locator('#grid .ag-header-cell[col-id="c0"] .ag-header-cell-resize')
    .boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 10);
  await page.mouse.down();
  await page.mouse.move(handle.x + 40, handle.y + 10, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await recorded(page)).map((e) => e[0])).toEqual(["columnResized"]);
  const [, col, width] = (await recorded(page))[0]!;
  expect(col).toBe(0);
  expect(width).toBeGreaterThan(100);
});

test("double click, context menu and keys are forwarded; default scroll/browser keys are swallowed", async ({
  page,
}) => {
  await mountGrid(page);
  const cell = page.locator('#grid [data-row="2"][data-col="2"]');
  await cell.dblclick();
  await cell.click({ button: "right" });
  const events = await recorded(page);
  expect(events.map((e) => e[0])).toEqual(["doubleClick", "contextMenu"]);
  expect(events[0]![1]).toEqual({ row: 2, col: 2 });
  expect(events[1]![1]).toEqual({ row: 2, col: 2 });

  const prevented = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>("#grid > div")!;
    const press = (init: KeyboardEventInit) => {
      const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      root.dispatchEvent(e);
      return e.defaultPrevented;
    };
    return {
      arrow: press({ key: "ArrowDown" }),
      tab: press({ key: "Tab" }),
      space: press({ key: " " }),
      copy: press({ key: "c", metaKey: true }),
      paste: press({ key: "v", ctrlKey: true }),
      reload: press({ key: "r", metaKey: true }),
      letter: press({ key: "a" }),
    };
  });
  expect(prevented).toEqual({
    arrow: true,
    tab: true,
    space: true,
    copy: false,
    paste: false,
    reload: false,
    letter: false,
  });
});
