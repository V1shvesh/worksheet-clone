import { expect, test, type Page } from "@playwright/test";
import {
  getCell,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  setCell,
  type CellData,
} from "@worksheet-clone/shared";
import type * as Y from "yjs";
import { mockCollab } from "./fixtures/collab";
import { mockApiFallback, mockSession } from "./fixtures/session";
import { me, mockWorkbooks, workbook } from "./fixtures/workbooks";
import { GridPage } from "./pages/grid-page";

const workbookId = "00000000-0000-4000-8000-000000000041";

async function open(page: Page, access: "read-write" | "readonly" = "read-write") {
  await mockApiFallback(page);
  await mockSession(page, me);
  await mockWorkbooks(page, [
    workbook(workbookId, "Flows", access === "readonly" ? "viewer" : "owner"),
  ]);
  const collab = await mockCollab(page, { access });
  await page.goto(`/workbooks/${workbookId}`);
  const grid = new GridPage(page);
  await expect(grid.cell(0, 0)).toBeVisible();
  await expect(page.getByRole("status", { name: "Connection" })).toContainText("Live");

  /** Server-side cell at visual (row, col), addressed by ids like a collaborator would. */
  const ids = (doc: Y.Doc, row: number, col: number) => {
    const sheetId = readSheetOrder(doc)[0]!;
    return [sheetId, readRowOrder(doc, sheetId)[row]!, readColOrder(doc, sheetId)[col]!] as const;
  };
  const serverCell = (row: number, col: number): CellData | undefined | null => {
    const doc = collab.serverDoc(workbookId);
    return doc ? getCell(doc, ...ids(doc, row, col)) : null;
  };
  const remoteSet = (row: number, col: number, data: CellData | undefined) =>
    collab.remoteEdit(workbookId, (doc) => setCell(doc, ...ids(doc, row, col), data));
  return { grid, collab, serverCell, remoteSet };
}

test("done-when: a formula follows a collaborator's edit live", async ({ page }) => {
  const { grid, serverCell, remoteSet } = await open(page);

  await grid.typeInto(0, 0, "1");
  await grid.typeInto(1, 0, "2");
  await grid.typeInto(2, 0, "3");
  await grid.typeInto(3, 0, "=SUM(A1:A3)");
  await expect(grid.cell(3, 0)).toHaveText("6");
  await expect.poll(() => serverCell(3, 0)).toMatchObject({ f: expect.stringContaining("SUM") });

  await remoteSet(1, 0, { v: 10 });

  await expect(grid.cell(1, 0)).toHaveText("10");
  await expect(grid.cell(3, 0)).toHaveText("14");
});

test.describe("range selection and clearing", () => {
  async function seed(page: Page) {
    const flow = await open(page);
    // A 4x3 block of numbers, written by a collaborator so only the clear is under test.
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 3; c++) await flow.remoteSet(r, c, { v: r * 10 + c + 1 });
    }
    await expect(flow.grid.cell(3, 2)).toHaveText("33");
    return flow;
  }

  test("a mouse-dragged range is outlined exactly and cleared in one update", async ({ page }) => {
    const { grid, collab, serverCell } = await seed(page);

    await grid.dragSelect([1, 1], [2, 2]);
    await grid.expectSelectionOver([1, 1], [2, 2]);

    const updates = collab.countUpdates(workbookId);
    await page.keyboard.press("Delete");
    await expect.poll(() => serverCell(2, 2)).toBeUndefined();

    for (const [r, c] of [
      [1, 1],
      [1, 2],
      [2, 1],
      [2, 2],
    ] as const) {
      expect(serverCell(r, c)).toBeUndefined();
      await expect(grid.cell(r, c)).toHaveText("");
    }
    // Neighbours outside the range are untouched.
    expect(serverCell(1, 0)).toEqual({ v: 11 });
    expect(serverCell(3, 2)).toEqual({ v: 33 });
    expect(updates.count).toBe(1);
    updates.stop();
  });

  test("a Shift+arrows range is outlined exactly and cleared in one update", async ({ page }) => {
    const { grid, collab, serverCell } = await seed(page);

    await grid.clickCell(0, 0);
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowDown");
    await page.keyboard.press("Shift+ArrowRight");
    await grid.expectSelectionOver([0, 0], [2, 1]);

    const updates = collab.countUpdates(workbookId);
    await page.keyboard.press("Delete");
    await expect.poll(() => serverCell(2, 1)).toBeUndefined();

    for (let r = 0; r <= 2; r++) {
      for (let c = 0; c <= 1; c++) expect(serverCell(r, c)).toBeUndefined();
    }
    expect(serverCell(0, 2)).toEqual({ v: 3 });
    expect(serverCell(3, 0)).toEqual({ v: 31 });
    expect(updates.count).toBe(1);
    updates.stop();
  });
});

test.describe("keyboard map", () => {
  test("arrows move and clamp at the top-left edges", async ({ page }) => {
    const { grid } = await open(page);

    await grid.clickCell(0, 0);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowLeft");
    await grid.expectActiveOn(0, 0);

    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowRight");
    await grid.expectActiveOn(1, 1);
    await page.keyboard.press("ArrowUp");
    await grid.expectActiveOn(0, 1);
    await page.keyboard.press("ArrowLeft");
    await grid.expectActiveOn(0, 0);
  });

  test("Tab, Enter, Shift+Enter and Shift+Tab move around", async ({ page }) => {
    const { grid, serverCell } = await open(page);

    await grid.clickCell(1, 1);
    await page.keyboard.press("Tab");
    await grid.expectActiveOn(1, 2);
    await page.keyboard.press("Shift+Tab");
    await grid.expectActiveOn(1, 1);

    // Enter commits the typed value and moves down; Shift+Enter commits and moves up.
    await page.keyboard.type("5");
    await page.keyboard.press("Enter");
    await grid.expectActiveOn(2, 1);
    await expect(grid.editor()).toHaveCount(0);
    await page.keyboard.type("6");
    await page.keyboard.press("Shift+Enter");
    await grid.expectActiveOn(1, 1);
    await expect.poll(() => serverCell(2, 1)).toEqual({ v: 6 });
    expect(serverCell(1, 1)).toEqual({ v: 5 });

    // Tab and Shift+Tab also commit an edit and move sideways.
    await page.keyboard.type("7");
    await page.keyboard.press("Tab");
    await grid.expectActiveOn(1, 2);
    await page.keyboard.type("8");
    await page.keyboard.press("Shift+Tab");
    await grid.expectActiveOn(1, 1);
    await expect.poll(() => serverCell(1, 2)).toEqual({ v: 8 });
    expect(serverCell(1, 1)).toEqual({ v: 7 });
  });

  test("plain Enter on a non-editing cell opens the editor, Shift+Enter moves up", async ({
    page,
  }) => {
    const { grid, remoteSet } = await open(page);
    await remoteSet(1, 0, { v: 12 });
    await expect(grid.cell(1, 0)).toHaveText("12");

    await grid.clickCell(1, 0);
    await page.keyboard.press("Shift+Enter");
    await grid.expectActiveOn(0, 0);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(grid.editor()).toHaveValue("12");
  });

  test("Escape cancels an edit without writing", async ({ page }) => {
    const { grid, collab, serverCell } = await open(page);

    await grid.clickCell(0, 0);
    const updates = collab.countUpdates(workbookId);
    await page.keyboard.type("99");
    await expect(grid.editor()).toHaveValue("99");
    await page.keyboard.press("Escape");

    await expect(grid.editor()).toHaveCount(0);
    await expect(grid.cell(0, 0)).toHaveText("");
    await grid.expectActiveOn(0, 0);
    // Focus is back on the grid: the next arrow still moves the selection.
    await page.keyboard.press("ArrowDown");
    await grid.expectActiveOn(1, 0);
    expect(serverCell(0, 0)).toBeUndefined();
    expect(updates.count).toBe(0);
    updates.stop();
  });

  test("F2 and Enter open a formula cell showing its A1 text; typing replaces it", async ({
    page,
  }) => {
    const { grid } = await open(page);
    await grid.typeInto(0, 0, "1");
    await grid.typeInto(1, 0, "2");
    await grid.typeInto(2, 0, "=SUM(A1:A2)");
    await expect(grid.cell(2, 0)).toHaveText("3");

    await grid.clickCell(2, 0);
    await page.keyboard.press("F2");
    await expect(grid.editor()).toHaveValue("=SUM(A1:A2)");
    await page.keyboard.press("Escape");
    await expect(grid.editor()).toHaveCount(0);

    await page.keyboard.press("Enter");
    await expect(grid.editor()).toHaveValue("=SUM(A1:A2)");
    await page.keyboard.press("Escape");

    // A printable key starts a fresh edit instead of appending to the formula.
    await page.keyboard.type("9");
    await expect(grid.editor()).toHaveValue("9");
    await page.keyboard.press("Enter");
    await expect(grid.cell(2, 0)).toHaveText("9");
  });

  test("movement clamps at the bottom and right edges of the sheet", async ({ page }) => {
    const { grid } = await open(page);

    // Column Z may be virtualized away in a normal viewport: get there by keyboard.
    await grid.clickCell(0, 0);
    for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowRight");
    await expect(grid.cell(0, 25)).toBeVisible();
    await grid.expectActiveOn(0, 25);
    await page.keyboard.press("Tab");
    await grid.expectActiveOn(0, 25);

    for (let i = 0; i < 105; i++) await page.keyboard.press("ArrowDown");
    await expect(grid.cell(99, 25)).toBeVisible();
    await grid.expectActiveOn(99, 25);
  });
});

test("the active cell is the anchor: typing after Shift+arrows writes A1, not the far corner", async ({
  page,
}) => {
  const { grid, serverCell } = await open(page);

  await grid.clickCell(0, 0);
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowRight");
  await grid.expectSelectionOver([0, 0], [1, 1]);
  await grid.expectActiveOn(0, 0);

  await page.keyboard.type("7");
  await page.keyboard.press("Enter");

  await expect(grid.cell(0, 0)).toHaveText("7");
  await expect(grid.cell(1, 1)).toHaveText("");
  await expect.poll(() => serverCell(0, 0)).toEqual({ v: 7 });
  expect(serverCell(1, 1)).toBeUndefined();
});

test("a collaborator's edit does not disturb a draft in progress", async ({ page }) => {
  const { grid, serverCell, remoteSet } = await open(page);

  await grid.clickCell(0, 0);
  await page.keyboard.type("5");
  await expect(grid.editor()).toHaveValue("5");

  await remoteSet(0, 0, { v: 99 });
  await expect.poll(() => serverCell(0, 0)).toEqual({ v: 99 });
  await expect(grid.editor()).toHaveValue("5");
  await expect(grid.editor()).toBeFocused();

  await page.keyboard.type("0");
  await page.keyboard.press("Enter");
  await expect(grid.cell(0, 0)).toHaveText("50");
  await expect.poll(() => serverCell(0, 0)).toEqual({ v: 50 });
});

test("a viewer can move around but cannot edit or clear", async ({ page }) => {
  const { grid, collab, serverCell, remoteSet } = await open(page, "readonly");
  await remoteSet(0, 0, { v: 3 });
  await expect(grid.cell(0, 0)).toHaveText("3");

  await grid.clickCell(0, 0);
  await grid.expectActiveOn(0, 0);
  await page.keyboard.press("ArrowRight");
  await grid.expectActiveOn(0, 1);
  await page.keyboard.press("ArrowDown");
  await grid.expectActiveOn(1, 1);
  await grid.clickCell(2, 2);
  await grid.expectActiveOn(2, 2);

  const updates = collab.countUpdates(workbookId);
  await page.keyboard.type("x");
  await expect(grid.editor()).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(grid.editor()).toHaveCount(0);
  await page.keyboard.press("F2");
  await expect(grid.editor()).toHaveCount(0);

  await grid.clickCell(0, 0);
  await page.keyboard.press("Delete");
  await page.keyboard.press("Backspace");
  await expect(grid.cell(0, 0)).toHaveText("3");
  expect(serverCell(0, 0)).toEqual({ v: 3 });
  expect(serverCell(2, 2)).toBeUndefined();
  expect(updates.count).toBe(0);
  updates.stop();
});

test.describe("scrolling and overlay alignment", () => {
  test("keyboard navigation scrolls the active cell into view with the outline on it", async ({
    page,
  }) => {
    const { grid } = await open(page);

    await grid.clickCell(0, 0);
    for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowDown");

    await expect(grid.cell(40, 0)).toBeVisible();
    await grid.expectActiveOn(40, 0);
    // The cell really is inside the grid area, not just matched under the header.
    const overlay = await grid.overlayBox();
    const box = (await grid.cellBox(40, 0))!;
    expect(box.y + box.height).toBeLessThanOrEqual(overlay.y + overlay.height + 1);
    expect(box.y).toBeGreaterThanOrEqual(overlay.y);

    // And back up again.
    for (let i = 0; i < 40; i++) await page.keyboard.press("ArrowUp");
    await grid.expectActiveOn(0, 0);
  });

  test("wheel scrolling keeps the outline and selection glued to their cells", async ({ page }) => {
    const { grid } = await open(page);

    await grid.clickCell(10, 0);
    await page.keyboard.press("Shift+ArrowRight");
    await grid.expectActiveOn(10, 0);
    await grid.expectSelectionOver([10, 0], [10, 1]);

    const before = (await grid.cellBox(10, 0))!.y;
    await grid.wheel(0, 120);
    await expect.poll(async () => (await grid.cellBox(10, 0))?.y).toBeLessThan(before - 50);
    await grid.expectActiveOn(10, 0);
    await grid.expectSelectionOver([10, 0], [10, 1]);

    // Far enough that row 10 leaves the viewport: the outline must not stay painted on top
    // of the grid body or its headers.
    await grid.wheel(0, 3000);
    const overlay = await grid.overlayBox();
    const header = (await grid.columnHeader(0).boundingBox())!;
    const bodyTop = header.y + header.height;
    await expect
      .poll(async () => {
        const box = await grid.cellBox(10, 0);
        return box === null || box.y + box.height <= bodyTop;
      })
      .toBe(true);
    for (const outline of [grid.activeCell(), grid.selectionRect()]) {
      if ((await outline.count()) === 0) continue; // not rendered at all: fine
      const box = (await outline.boundingBox())!;
      const visibleTop = Math.max(box.y, bodyTop);
      const visibleBottom = Math.min(box.y + box.height, overlay.y + overlay.height);
      expect(visibleBottom - visibleTop).toBeLessThanOrEqual(0);
    }

    // Scrolling back brings the outline back onto its cell.
    await grid.wheel(0, -5000);
    await expect(grid.cell(10, 0)).toBeVisible();
    await grid.expectActiveOn(10, 0);
    await grid.expectSelectionOver([10, 0], [10, 1]);
  });
});
