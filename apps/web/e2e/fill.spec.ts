import { expect, test } from "@playwright/test";
import { BOB } from "./fixtures/collab";
import { openWorkbook } from "./fixtures/grid-workbook";

const workbookId = "00000000-0000-4000-8000-000000000062";

test("done-when: dragging the fill handle down 10 rows shifts =A1*2 relatively, in one update and one undo", async ({
  page,
}) => {
  const { grid, serverCell, remote, updates } = await openWorkbook(page, workbookId);
  const input = (row: number) => row + 1;
  await remote((set) => {
    for (let r = 0; r <= 10; r++) set(r, 0, { v: input(r) });
  }, BOB);
  await expect(grid.cell(10, 0)).toHaveText("11");

  await grid.typeInto(0, 1, "=A1*2");
  await expect(grid.cell(0, 1)).toHaveText("2");
  await grid.clickCell(0, 1);

  const counter = updates();
  await grid.dragFillHandle(10, 1);

  for (let r = 0; r <= 10; r++) {
    await expect(grid.cell(r, 1)).toHaveText(String(input(r) * 2));
  }
  await expect.poll(() => serverCell(10, 1)).not.toBeUndefined();
  // The formula bar shows the relative references of the cells we check.
  for (const r of [1, 2, 6, 10]) {
    await grid.clickCell(r, 1);
    await expect(grid.formulaBar()).toHaveValue(`=A${r + 1}*2`);
  }
  expect(counter.count).toBe(1);

  // One undo removes the whole fill and leaves the typed B1.
  await grid.chord("ControlOrMeta+z");
  await expect(grid.cell(10, 1)).toHaveText("");
  await expect(grid.cell(1, 1)).toHaveText("");
  await expect(grid.cell(0, 1)).toHaveText("2");
  await expect.poll(() => serverCell(10, 1)).toBeUndefined();
  expect(serverCell(1, 1)).toBeUndefined();
  expect(counter.count).toBe(2);
  counter.stop();
});

test("the handle sits on the selection corner, previews along one axis and Escape cancels", async ({
  page,
}) => {
  const { grid, serverCell, updates } = await openWorkbook(page, workbookId);
  await grid.typeInto(0, 0, "5");
  await grid.clickCell(0, 0);
  await expect(grid.fillHandle()).toBeVisible();

  // Handle centre is on the cell's bottom-right corner.
  const cell = (await grid.cellBox(0, 0))!;
  await expect
    .poll(async () => {
      const h = (await grid.fillHandle().boundingBox())!;
      return Math.max(
        Math.abs(h.x + h.width / 2 - (cell.x + cell.width)),
        Math.abs(h.y + h.height / 2 - (cell.y + cell.height)),
      );
    })
    .toBeLessThanOrEqual(2);

  const target = (await grid.cellBox(4, 1))!;
  const handle = (await grid.fillHandle().boundingBox())!;
  const counter = updates();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  // 4 rows down, 1 column right: vertical wins, so the preview covers A1:A5 only.
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 });
  await expect(grid.fillPreview()).toBeVisible();
  const a1 = (await grid.cellBox(0, 0))!;
  const a5 = (await grid.cellBox(4, 0))!;
  const preview = (await grid.fillPreview().boundingBox())!;
  expect(Math.abs(preview.x - a1.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(preview.width - a1.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(preview.y + preview.height - (a5.y + a5.height))).toBeLessThanOrEqual(2);

  await page.keyboard.press("Escape");
  await expect(grid.fillPreview()).toHaveCount(0);
  await page.mouse.up();
  await expect(grid.cell(3, 0)).toHaveText("");
  expect(serverCell(3, 0)).toBeUndefined();
  expect(counter.count).toBe(0);
  counter.stop();
});

test("fills right with a series and releasing inside the selection does nothing", async ({
  page,
}) => {
  const { grid, serverCell, updates } = await openWorkbook(page, workbookId);
  await grid.typeInto(0, 0, "1");
  await grid.typeInto(0, 1, "2");
  await grid.dragSelect([0, 0], [0, 1]);

  const counter = updates();
  await grid.dragFillHandle(0, 0); // back inside the selection
  expect(counter.count).toBe(0);
  await expect(grid.cell(0, 2)).toHaveText("");

  await grid.dragFillHandle(0, 5);
  for (const [c, text] of [
    [2, "3"],
    [3, "4"],
    [4, "5"],
    [5, "6"],
  ] as const) {
    await expect(grid.cell(0, c)).toHaveText(text);
  }
  await expect.poll(() => serverCell(0, 5)).toEqual({ v: 6 });
  expect(counter.count).toBe(1);
  // The selection grew to source plus fill.
  await grid.expectSelectionOver([0, 0], [0, 5]);
  counter.stop();
});

test("formats of the source repeat down the fill", async ({ page }) => {
  const { grid, serverFormat } = await openWorkbook(page, workbookId);
  await grid.typeInto(0, 0, "Item 1");
  await grid.clickCell(0, 0);
  await grid.toolbarButton("Bold").click();
  await grid.clickCell(0, 0);
  await grid.dragFillHandle(3, 0);
  await expect(grid.cell(3, 0)).toHaveText("Item 4");
  await expect.poll(() => serverFormat(3, 0)).toEqual({ b: true });
  expect(serverFormat(1, 0)).toEqual({ b: true });
});

test("viewers get no fill handle", async ({ page }) => {
  const { grid } = await openWorkbook(page, workbookId, "readonly");
  await grid.clickCell(0, 0);
  await expect(grid.activeCell()).toBeVisible();
  await expect(grid.fillHandle()).toHaveCount(0);
});
