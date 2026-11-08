import { expect, test, type Page } from "@playwright/test";
import { readSheetOrder } from "@worksheet-clone/shared";
import { BOB, mockCollab, type CollabAccess } from "./fixtures/collab";
import { mockApiFallback, mockSession } from "./fixtures/session";
import { me, mockWorkbooks, workbook } from "./fixtures/workbooks";
import { GridPage } from "./pages/grid-page";
import { SheetTabsPage } from "./pages/sheet-tabs-page";

const workbookId = "00000000-0000-4000-8000-000000000081";

async function open(page: Page, access: CollabAccess = "read-write") {
  await mockApiFallback(page);
  await mockSession(page, me);
  await mockWorkbooks(page, [
    workbook(workbookId, "Q3 budget", access === "readonly" ? "viewer" : "owner"),
  ]);
  const collab = await mockCollab(page, { access });
  await page.goto(`/workbooks/${workbookId}`);
  await expect(page.getByRole("status", { name: "Connection" })).toContainText("All changes saved");
  const grid = new GridPage(page);
  await expect(grid.cell(0, 0)).toBeVisible();
  const sheetIds = () => {
    const doc = collab.serverDoc(workbookId);
    return doc ? readSheetOrder(doc) : [];
  };
  return { collab, grid, tabs: new SheetTabsPage(page), sheetIds };
}

/** The cursor box lines up with the cell it marks (within a pixel or two of border). */
async function expectCursorOn(grid: GridPage, row: number, col: number) {
  await expect
    .poll(async () => {
      const cursor = await grid.remoteCursor(BOB.userId).boundingBox();
      const cell = await grid.cell(row, col).boundingBox();
      if (!cursor || !cell) return null;
      return [cursor.x - cell.x, cursor.y - cell.y].map((d) => Math.abs(d) <= 2);
    })
    .toEqual([true, true]);
}

test("a collaborator shows up as an avatar with their initials and email", async ({ page }) => {
  const { collab } = await open(page);
  await expect(page.getByTestId("presence-avatars")).toHaveCount(0);

  const bob = collab.presencePeer(workbookId, BOB);

  const avatar = page.getByTestId("presence-avatar");
  await expect(avatar).toHaveCount(1);
  await expect(avatar).toHaveText("B");
  await expect(avatar).toHaveAttribute("title", BOB.email);
  await expect(avatar).toHaveAttribute("data-user-id", BOB.userId);

  bob.leave();
  await expect(page.getByTestId("presence-avatars")).toHaveCount(0);
});

test("a collaborator's cursor follows their selection and disappears when they leave", async ({
  page,
}) => {
  const { collab, grid, sheetIds } = await open(page);
  const bob = collab.presencePeer(workbookId, BOB);
  await expect(grid.remoteCursor()).toHaveCount(0); // no sheet or selection yet

  bob.moveTo(sheetIds()[0]!, { row: 2, col: 1 });
  await expect(grid.remoteCursor(BOB.userId)).toHaveCount(1);
  await expect(grid.remoteCursor(BOB.userId)).toContainText("bob");
  await expectCursorOn(grid, 2, 1);
  await expect(grid.remoteSelection()).toHaveCount(1); // the tint exists even for one cell

  bob.moveTo(sheetIds()[0]!, { row: 4, col: 3 }, { row: 6, col: 4 });
  await expectCursorOn(grid, 4, 3);

  // Our own selection is unaffected and stays above his marks.
  await grid.clickCell(0, 0);
  await expect(grid.activeCell()).toBeVisible();

  bob.leave();
  await expect(grid.remoteCursor()).toHaveCount(0);
  await expect(grid.remoteSelection()).toHaveCount(0);
});

test("his cursor is hidden while he is on another sheet and returns when he comes back", async ({
  page,
}) => {
  const { collab, grid, tabs, sheetIds } = await open(page);
  await tabs.add();
  await tabs.expectNames(["Sheet1", "Sheet2"]);
  await tabs.tab("Sheet1").click();
  await expect(grid.cell(0, 0)).toBeVisible();
  const [first, second] = sheetIds() as [string, string];

  const bob = collab.presencePeer(workbookId, BOB);
  bob.moveTo(first, { row: 1, col: 1 });
  await expect(grid.remoteCursor(BOB.userId)).toHaveCount(1);

  bob.moveTo(second, { row: 1, col: 1 });
  await expect(grid.remoteCursor()).toHaveCount(0);
  // He is still in the workbook.
  await expect(page.getByTestId("presence-avatar")).toHaveCount(1);

  bob.moveTo(first, { row: 3, col: 2 });
  await expectCursorOn(grid, 3, 2);

  // Following him: the cursor shows on whichever sheet we open if it is his.
  bob.moveTo(second, { row: 5, col: 0 });
  await expect(grid.remoteCursor()).toHaveCount(0);
  await tabs.tab("Sheet2").click();
  await expect(grid.remoteCursor(BOB.userId)).toHaveCount(1);
  await expectCursorOn(grid, 5, 0);
});

test("a viewer sees collaborators too", async ({ page }) => {
  const { collab, grid, sheetIds } = await open(page, "readonly");
  const bob = collab.presencePeer(workbookId, BOB);
  bob.moveTo(sheetIds()[0]!, { row: 2, col: 2 });

  await expect(page.getByTestId("presence-avatar")).toHaveAttribute("title", BOB.email);
  await expectCursorOn(grid, 2, 2);
});
