import { expect, test } from "@playwright/test";
import { getCell, readColOrder, readRowOrder, readSheetOrder } from "@worksheet-clone/shared";
import { mockCollab } from "./fixtures/collab";
import { mockApiFallback, mockSession } from "./fixtures/session";
import { me, mockWorkbooks, workbook } from "./fixtures/workbooks";
import { GridPage } from "./pages/grid-page";

const workbookId = "00000000-0000-4000-8000-000000000031";

// Wide enough that AG Grid renders all 26 columns instead of virtualizing the right ones away.
test.use({ viewport: { width: 3000, height: 900 } });

test("opens a workbook, shows the grid and computes a formula", async ({ page }) => {
  await mockApiFallback(page);
  await mockSession(page, me);
  await mockWorkbooks(page, [workbook(workbookId, "Q3 budget", "owner")]);
  const collab = await mockCollab(page, { access: "read-write" });
  await page.goto(`/workbooks/${workbookId}`);

  const grid = new GridPage(page);
  await expect(grid.columnHeader(0)).toHaveText("A");
  await expect(grid.columnHeader(25)).toHaveText("Z");
  await expect(grid.rowHeader(0)).toHaveText("1");

  await grid.typeInto(0, 0, "42");
  await expect(grid.cell(0, 0)).toHaveText("42");
  await expect(grid.editor()).toHaveCount(0);

  await grid.typeInto(0, 1, "=A1*2");
  await expect(grid.cell(0, 1)).toHaveText("84");

  await expect
    .poll(() => {
      const doc = collab.serverDoc(workbookId);
      if (!doc) return null;
      const sheetId = readSheetOrder(doc)[0]!;
      const rowId = readRowOrder(doc, sheetId)[0]!;
      const colId = readColOrder(doc, sheetId)[0]!;
      return getCell(doc, sheetId, rowId, colId);
    })
    .toEqual({ v: 42 });
});
