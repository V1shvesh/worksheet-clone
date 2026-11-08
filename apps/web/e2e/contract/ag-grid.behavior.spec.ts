// Adapter behavior the shared contract does not cover: gestures AG Grid owns (column resize), the DOM attributes the future GridPage page object relies on, and key handling.
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

test("dragging a column header emits nothing and leaves AG Grid's column order unchanged", async ({
  page,
}) => {
  await mountGrid(page);
  // AG Grid positions header cells with CSS, so DOM order proves nothing: compare x positions.
  const lefts = () =>
    page
      .locator("#grid .ag-header-cell")
      .evaluateAll((els) =>
        els.map((e) => [e.getAttribute("col-id"), Math.round(e.getBoundingClientRect().left)]),
      );
  const before = await lefts();
  const header = (await page.locator('[data-col-header="1"]').boundingBox())!;
  await page.mouse.move(header.x + 20, header.y + 8);
  await page.mouse.down();
  await page.mouse.move(header.x + 100, header.y + 8, { steps: 5 });
  await page.mouse.move(header.x + 230, header.y + 8, { steps: 10 });
  // Mid-drag nothing may have moved (no animated move that snaps back).
  expect(await lefts()).toEqual(before);
  await page.mouse.up();
  expect(await recorded(page)).toEqual([]);
  expect(await lefts()).toEqual(before);
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
  await page.mouse.move(handle.x + 20, handle.y + 10, { steps: 5 });
  await page.mouse.move(handle.x + 40, handle.y + 10, { steps: 5 });
  // Nothing is emitted while the drag is in progress (not once per pixel)...
  expect(await recorded(page)).toEqual([]);
  await page.mouse.up();
  // ...and exactly one event on release.
  await expect.poll(async () => (await recorded(page)).length).toBe(1);
  await page.waitForTimeout(300);
  const events = await recorded(page);
  expect(events.map((e) => e[0])).toEqual(["columnResized"]);
  const [, col, width] = events[0]!;
  expect(col).toBe(0);
  expect(width).toBeGreaterThan(100);
  // The reported width is the one AG Grid shows.
  const shown = (await page.locator('#grid .ag-header-cell[col-id="c0"]').boundingBox())!;
  expect(Math.round(shown.width)).toBe(width);
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
      altChar: press({ key: "€", altKey: true }),
      altGrChar: press({ key: "@", ctrlKey: true, altKey: true }),
      ctrlLetterAlone: press({ key: "a", ctrlKey: true }),
    };
  });
  expect(prevented).toEqual({
    arrow: true,
    tab: true,
    space: true,
    copy: false,
    paste: false,
    reload: false,
    // Typed characters are swallowed: they start our floating editor, which takes focus before
    // the keypress and would otherwise receive the character a second time.
    letter: true,
    altChar: true,
    altGrChar: true,
    ctrlLetterAlone: false,
  });
});

test("clicking a cell keeps DOM focus on the grid container, never on AG Grid's row", async ({
  page,
}) => {
  await mountGrid(page);
  await page.locator('#grid [data-row="2"][data-col="1"]').click();
  const focused = await page.evaluate(() => ({
    role: document.activeElement?.getAttribute("role") ?? null,
    insideGrid: document.querySelector("#grid")?.contains(document.activeElement) ?? false,
    isRow: document.activeElement?.classList.contains("ag-row") ?? false,
  }));
  expect(focused.insideGrid).toBe(true);
  expect(focused.isRow).toBe(false);
  expect(focused.role).not.toBe("row");
});
