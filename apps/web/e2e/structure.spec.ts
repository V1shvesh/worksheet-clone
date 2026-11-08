import { expect, test } from "@playwright/test";
import {
  getCell,
  getColWidthsMap,
  getRowHeightsMap,
  insertRows,
  deleteRows,
  readColOrder,
  readRowOrder,
  readSheetOrder,
} from "@worksheet-clone/shared";
import type * as Y from "yjs";
import { BOB } from "./fixtures/collab";
import { openWorkbook } from "./fixtures/grid-workbook";

const workbookId = "00000000-0000-4000-8000-000000000071";

/** The server's copy of the first sheet, for assertions that must not go through the page. */
async function open(page: Parameters<typeof openWorkbook>[0], access?: "read-write" | "readonly") {
  const wb = await openWorkbook(page, workbookId, access);
  const doc = () => {
    const d = wb.collab.serverDoc(workbookId);
    if (!d) throw new Error("the server has no copy of the workbook yet");
    return d;
  };
  const sheet = () => readSheetOrder(doc())[0]!;
  return {
    ...wb,
    doc,
    sheet,
    rowCount: () => readRowOrder(doc(), sheet()).length,
    colCount: () => readColOrder(doc(), sheet()).length,
    rowId: (i: number) => readRowOrder(doc(), sheet())[i]!,
    colId: (j: number) => readColOrder(doc(), sheet())[j]!,
    colWidth: (j: number) => getColWidthsMap(doc(), sheet()).get(readColOrder(doc(), sheet())[j]!),
    rowHeight: (i: number) =>
      getRowHeightsMap(doc(), sheet()).get(readRowOrder(doc(), sheet())[i]!),
    /** A collaborator's structure edit, as ONE update, attributed to Bob. */
    structure: (change: (d: Y.Doc, sheetId: string) => void) =>
      wb.collab.remoteEdit(
        workbookId,
        (d) => {
          change(d, readSheetOrder(d)[0]!);
        },
        BOB,
      ),
  };
}

test.describe("concurrent insert while you type (done-when)", () => {
  test("(a) your commit lands on the SAME row after a collaborator's insert above, even though it was sent before you saw the insert", async ({
    page,
  }) => {
    const { grid, collab, doc, sheet, rowId, colId, structure, rowCount } = await open(page);
    const b5 = { row: rowId(4), col: colId(1) };

    // Make the race deterministic: from here the server's messages to the page are held, so the
    // page keeps the old 100-row view while the server gets ahead of it. The page's own messages
    // still reach the server.
    await grid.clickCell(4, 1);
    collab.holdDelivery();
    await structure((d, s) => insertRows(d, s, 4, 1)); // above row 5
    await expect.poll(rowCount).toBe(101);

    // The user, who has not seen the insert, types 42 into B5 and commits.
    await page.keyboard.type("42");
    await page.keyboard.press("Enter");
    // The commit reaches the server addressed by the row's id: the server applies it to the
    // old B5 (now row 6), not to the new empty row.
    await expect.poll(() => getCell(doc(), sheet(), b5.row, b5.col)).toEqual({ v: 42 });
    await expect(grid.cell(4, 1)).toHaveText("42"); // still the stale view

    collab.releaseDelivery();
    await expect(grid.cell(5, 1)).toHaveText("42");
    await expect(grid.cell(4, 1)).toHaveText("");
    expect(readRowOrder(doc(), sheet())[5]).toBe(b5.row);
    const inserted = readRowOrder(doc(), sheet())[4]!;
    expect(inserted).not.toBe(b5.row);
    expect(getCell(doc(), sheet(), inserted, b5.col)).toBeUndefined();
    expect(getCell(doc(), sheet(), b5.row, b5.col)).toEqual({ v: 42 });
  });

  test("(b) an editor that is already open stays on the same cell (now B6) and commits there", async ({
    page,
  }) => {
    const { grid, doc, sheet, rowId, colId, structure, rowCount } = await open(page);
    const b5 = { row: rowId(4), col: colId(1) };

    await grid.clickCell(4, 1);
    await page.keyboard.type("42");
    await expect(grid.editor()).toHaveValue("42");

    await structure((d, s) => insertRows(d, s, 4, 1));
    await expect.poll(rowCount).toBe(101);
    // The cell the editor belongs to moved down one row; the editor followed it and kept its text.
    await expect(grid.cell(5, 1)).toBeVisible();
    await expect
      .poll(async () => {
        const editor = await grid.editor().boundingBox();
        const cell = await grid.cellBox(5, 1);
        return editor && cell ? Math.abs(editor.y - cell.y) : Infinity;
      })
      .toBeLessThanOrEqual(2);
    await expect(grid.editor()).toHaveValue("42");

    await page.keyboard.press("Enter");
    await expect(grid.cell(5, 1)).toHaveText("42");
    await expect(grid.cell(4, 1)).toHaveText("");
    await expect.poll(() => getCell(doc(), sheet(), b5.row, b5.col)).toEqual({ v: 42 });
    expect(readRowOrder(doc(), sheet())[5]).toBe(b5.row);
  });
});

test.describe("context menu", () => {
  test("insert 2 rows above a 2-row selection: formulas follow, one update, one undo step", async ({
    page,
  }) => {
    const { grid, remote, serverCell, updates, rowCount } = await open(page);
    await remote((set) => {
      for (let r = 0; r < 10; r++) set(r, 0, { v: r + 1 });
    }, BOB);
    await expect(grid.cell(9, 0)).toHaveText("10");
    await grid.typeInto(11, 1, "=SUM(A1:A10)");
    await expect(grid.cell(11, 1)).toHaveText("55");
    await expect.poll(() => serverCell(11, 1)?.f).toBeDefined();

    await grid.selectRows(2, 3);
    await grid.rightClickRowHeader(3);
    await expect(grid.menuItem("insert-rows-above")).toHaveText("Insert 2 rows above");
    const counter = updates();
    await grid.chooseMenuItem("insert-rows-above");

    await expect.poll(rowCount).toBe(102);
    expect(counter.count).toBe(1);
    // The new rows are selected; the data moved down two and headers renumbered.
    await grid.expectActiveOn(2, 0);
    await expect(grid.cell(2, 0)).toHaveText("");
    await expect(grid.cell(4, 0)).toHaveText("3");
    expect(await grid.rowHeaderLabel(13)).toBe("14");
    // The SUM range grew by the two inserted rows (the insert is inside it) and moved with its cell.
    await expect(grid.cell(13, 1)).toHaveText("55");
    await grid.clickCell(13, 1);
    await expect(grid.formulaBar()).toHaveValue("=SUM(A1:A12)");

    await grid.chord("ControlOrMeta+z");
    await expect.poll(rowCount).toBe(100);
    expect(counter.count).toBe(2);
    await expect(grid.cell(11, 1)).toHaveText("55");
    await expect(grid.cell(4, 0)).toHaveText("5");
    await grid.clickCell(11, 1);
    await expect(grid.formulaBar()).toHaveValue("=SUM(A1:A10)");
  });

  test("deleting the last row of a range shrinks it, and undo brings the row back", async ({
    page,
  }) => {
    const { grid, remote, updates, rowCount, serverCell } = await open(page);
    await remote((set) => {
      for (let r = 0; r < 3; r++) set(r, 0, { v: r + 1 });
    }, BOB);
    await grid.typeInto(0, 3, "=SUM(A1:A3)");
    await expect(grid.cell(0, 3)).toHaveText("6");
    await expect.poll(() => serverCell(0, 3)?.f).toBeDefined();

    await grid.rightClickRowHeader(2);
    await expect(grid.menuItem("delete-rows")).toHaveText("Delete row 3");
    const counter = updates();
    await grid.chooseMenuItem("delete-rows");

    await expect.poll(rowCount).toBe(99);
    expect(counter.count).toBe(1);
    await expect(grid.cell(0, 3)).toHaveText("3"); // A1 + A2
    await grid.clickCell(0, 3);
    await expect(grid.formulaBar()).toHaveValue("=SUM(A1:A2)");

    await grid.chord("ControlOrMeta+z");
    await expect.poll(rowCount).toBe(100);
    await expect(grid.cell(0, 3)).toHaveText("6");
    await expect(grid.cell(2, 0)).toHaveText("3");
    await grid.clickCell(0, 3);
    await expect(grid.formulaBar()).toHaveValue("=SUM(A1:A3)");
  });

  test("deleting the row a single-cell reference points at gives #REF!", async ({ page }) => {
    const { grid, remote, rowCount, serverCell } = await open(page);
    await remote((set) => set(4, 0, { v: 5 }), BOB);
    await expect(grid.cell(4, 0)).toHaveText("5");
    await grid.typeInto(0, 1, "=A5+1");
    await expect(grid.cell(0, 1)).toHaveText("6");
    await expect.poll(() => serverCell(0, 1)?.f).toBeDefined();

    await grid.rightClickRowHeader(4);
    await grid.chooseMenuItem("delete-rows");
    await expect.poll(rowCount).toBe(99);
    await expect(grid.cell(0, 1)).toHaveText("#REF!");
    await grid.clickCell(0, 1);
    await expect(grid.formulaBar()).toHaveValue(/#REF!/);
  });

  test("insert and delete columns from the column header", async ({ page }) => {
    const { grid, remote, colCount, serverCell, updates } = await open(page);
    await remote((set) => {
      set(0, 0, { v: 1 });
      set(0, 1, { v: 2 });
    }, BOB);
    await grid.typeInto(0, 2, "=A1+B1");
    await expect(grid.cell(0, 2)).toHaveText("3");
    await expect.poll(() => serverCell(0, 2)?.f).toBeDefined();

    await grid.rightClickColumnHeader(1);
    await expect(grid.menuItem("insert-cols-left")).toHaveText("Insert 1 column left");
    const counter = updates();
    await grid.chooseMenuItem("insert-cols-left");
    await expect.poll(colCount).toBe(27);
    expect(counter.count).toBe(1);
    // B moved to C, the formula to D, and its reference followed.
    await expect(grid.cell(0, 2)).toHaveText("2");
    await expect(grid.cell(0, 3)).toHaveText("3");
    await grid.clickCell(0, 3);
    await expect(grid.formulaBar()).toHaveValue("=A1+C1");
    expect(await grid.columnHeader(3).textContent()).toContain("D");

    await grid.chord("ControlOrMeta+z");
    await expect.poll(colCount).toBe(26);
    await expect(grid.cell(0, 2)).toHaveText("3");

    // Now delete the referenced column B: the reference breaks.
    await grid.rightClickColumnHeader(1);
    await expect(grid.menuItem("delete-cols")).toHaveText("Delete column B");
    await grid.chooseMenuItem("delete-cols");
    await expect.poll(colCount).toBe(25);
    await expect(grid.cell(0, 1)).toHaveText("#REF!");
    await grid.clickCell(0, 1);
    await expect(grid.formulaBar()).toHaveValue("=A1+#REF!");
  });

  test("Ctrl+Alt+= inserts rows above the selected rows and Ctrl+Alt+- deletes the selected rows", async ({
    page,
  }) => {
    const { grid, remote, rowCount } = await open(page);
    await remote((set) => set(3, 0, { v: "four" }), BOB);
    await expect(grid.cell(3, 0)).toHaveText("four");

    await grid.selectRows(1, 2);
    await grid.chord("Control+Alt+Equal");
    await expect.poll(rowCount).toBe(102);
    await expect(grid.cell(5, 0)).toHaveText("four");
    // The inserted rows are the selection now, so the delete chord removes exactly them.
    await grid.chord("Control+Alt+Minus");
    await expect.poll(rowCount).toBe(100);
    await expect(grid.cell(3, 0)).toHaveText("four");
  });
});

test.describe("collaborator deletes what you are on", () => {
  test("a remote delete of your selected row moves the selection to the row that took its place", async ({
    page,
  }) => {
    const { grid, structure, serverCell, rowCount } = await open(page);
    await grid.clickCell(4, 1);
    await grid.expectActiveOn(4, 1);
    await structure((d, s) => deleteRows(d, s, [readRowOrder(d, s)[4]!]));
    await expect.poll(rowCount).toBe(99);
    await grid.expectActiveOn(4, 1);
    // Later actions use the repaired selection: typing lands in the row now at B5.
    await page.keyboard.type("7");
    await page.keyboard.press("Enter");
    await expect(grid.cell(4, 1)).toHaveText("7");
    await expect.poll(() => serverCell(4, 1)).toEqual({ v: 7 });
  });

  test("a remote delete of the row you are editing cancels the edit and tells you", async ({
    page,
  }) => {
    const { grid, structure, serverCell, rowCount } = await open(page);
    await grid.clickCell(6, 0);
    await page.keyboard.type("x");
    await expect(grid.editor()).toBeVisible();
    await structure((d, s) => deleteRows(d, s, [readRowOrder(d, s)[6]!]));
    await expect.poll(rowCount).toBe(99);
    await expect(grid.editor()).toHaveCount(0);
    await expect(grid.toasts()).toContainText("The row you were editing was deleted");
    expect(serverCell(6, 0)).toBeUndefined();
    await expect(grid.cell(6, 0)).toHaveText("");
  });
});

test.describe("resizing", () => {
  test("a column drag persists in the server doc, undoes and redoes, and survives a reload", async ({
    page,
  }) => {
    const { grid, colWidth } = await open(page);
    const before = await grid.columnWidth(1);
    expect(before).toBeGreaterThan(0);
    await grid.dragColumnResize(1, 60);
    await expect.poll(() => colWidth(1)).toBeGreaterThan(before + 40);
    const stored = colWidth(1)!;
    expect(await grid.columnWidth(1)).toBe(stored);

    await grid.clickCell(0, 0);
    await grid.chord("ControlOrMeta+z");
    await expect.poll(() => grid.columnWidth(1)).toBe(before);
    await expect.poll(() => colWidth(1)).toBeUndefined();
    await grid.chord("ControlOrMeta+Shift+z");
    await expect.poll(() => grid.columnWidth(1)).toBe(stored);
    await expect.poll(() => colWidth(1)).toBe(stored);

    // A reload starts a new session (no undo history), but the width comes back from the server.
    await page.reload();
    await expect(grid.cell(0, 0)).toBeVisible();
    await expect.poll(() => grid.columnWidth(1)).toBe(stored);
  });

  test("a row drag with the header handle persists and undoes", async ({ page }) => {
    const { grid, rowHeight } = await open(page);
    const before = await grid.rowHeight(2);
    expect(before).toBeGreaterThan(0);
    const below = await grid.rowHeight(3);
    await grid.dragRowResize(2, 20);
    await expect.poll(() => rowHeight(2)).toBeGreaterThan(40);
    const stored = rowHeight(2)!;
    // The header's box is the row height minus a border pixel at most.
    expect(Math.abs((await grid.rowHeight(2)) - stored)).toBeLessThanOrEqual(1);
    expect(await grid.rowHeight(3)).toBe(below); // only that row changed

    await grid.clickCell(0, 0);
    await grid.chord("ControlOrMeta+z");
    await expect.poll(() => grid.rowHeight(2)).toBe(before);
    await expect.poll(() => rowHeight(2)).toBeUndefined();
  });
});

test.describe("viewer", () => {
  test("menu items are disabled, there is no row handle and a column drag is not stored", async ({
    page,
  }) => {
    const { grid, colWidth } = await open(page, "readonly");
    const before = await grid.columnWidth(1);
    expect(before).toBeGreaterThan(0);
    await grid.rightClickCell(2, 2);
    for (const id of [
      "insert-rows-above",
      "insert-rows-below",
      "insert-cols-left",
      "insert-cols-right",
      "delete-rows",
      "delete-cols",
      "clear",
    ]) {
      await expect(grid.menuItem(id)).toBeDisabled();
    }
    await page.keyboard.press("Escape");

    const header = (await grid.rowHeader(2).boundingBox())!;
    await page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
    await expect(grid.rowResizeHandle()).toHaveCount(0);

    await grid.dragColumnResize(1, 60);
    // The grid snaps back to the stored width and nothing is written.
    await expect.poll(() => grid.columnWidth(1)).toBe(before);
    expect(colWidth(1)).toBeUndefined();
  });
});
