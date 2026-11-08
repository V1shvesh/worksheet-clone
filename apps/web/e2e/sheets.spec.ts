import { expect, test, type Page } from "@playwright/test";
import {
  addSheet,
  deleteSheet,
  getCell,
  getSheetName,
  isSheetHidden,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  setCell,
  type CellData,
} from "@worksheet-clone/shared";
import type * as Y from "yjs";
import { BOB, mockCollab, type CollabAccess } from "./fixtures/collab";
import { mockApiFallback, mockSession } from "./fixtures/session";
import { me, mockWorkbooks, workbook } from "./fixtures/workbooks";
import { GridPage } from "./pages/grid-page";
import { SheetTabsPage } from "./pages/sheet-tabs-page";

const workbookId = "00000000-0000-4000-8000-000000000051";
const BOOK = "Q3 budget";

// Opens the workbook from the list page, so the browser history has an entry
// to go Back to (switching tabs must not add entries).
async function open(page: Page, access: CollabAccess = "read-write") {
  await mockApiFallback(page);
  await mockSession(page, me);
  const collabRef: { current?: Awaited<ReturnType<typeof mockCollab>> } = {};
  const store = await mockWorkbooks(
    page,
    [workbook(workbookId, BOOK, access === "readonly" ? "viewer" : "owner")],
    [],
    {
      onRenamed: (id, from, to) =>
        collabRef.current?.broadcastWorkbookRenamed(
          id,
          { userId: me.id, email: me.email },
          from,
          to,
        ),
    },
  );
  const collab = await mockCollab(page, { access });
  collabRef.current = collab;

  await page.goto("/");
  await page.getByRole("link", { name: BOOK }).click();
  await expect(page.getByRole("status", { name: "Connection" })).toContainText("Live");

  const tabs = new SheetTabsPage(page);
  const grid = new GridPage(page);
  const toasts = page.getByTestId("toast");
  const serverNames = (): (string | undefined)[] => {
    const doc = collab.serverDoc(workbookId);
    return doc ? readSheetOrder(doc).map((id) => getSheetName(doc, id)) : [];
  };
  return { collab, store, tabs, grid, toasts, serverNames };
}

/** Add Sheet2 and Sheet3 through the UI. */
async function addTwo(tabs: SheetTabsPage) {
  await tabs.add();
  await tabs.expectNames(["Sheet1", "Sheet2"]);
  await tabs.add();
  await tabs.expectNames(["Sheet1", "Sheet2", "Sheet3"]);
}

test("add, switch, reload and Back: the sheet lives in the URL and tabs don't walk history", async ({
  page,
}) => {
  const { tabs, grid } = await open(page);
  await tabs.expectNames(["Sheet1"]);
  await addTwo(tabs);

  // A new sheet opens straight away.
  await expect(tabs.activeTab()).toHaveText("Sheet3");
  expect(tabs.urlSheetId()).toBe(await tabs.sheetId("Sheet3"));

  await grid.typeInto(0, 0, "on sheet three");
  await tabs.open("Sheet1");
  await expect(tabs.activeTab()).toHaveText("Sheet1");
  await expect.poll(() => tabs.urlSheetId()).toBe(await tabs.sheetId("Sheet1"));
  await expect(grid.cell(0, 0)).toHaveText("");
  await tabs.open("Sheet3");
  await expect(grid.cell(0, 0)).toHaveText("on sheet three");

  await tabs.open("Sheet2");
  const sheet2 = await tabs.sheetId("Sheet2");
  await expect.poll(() => tabs.urlSheetId()).toBe(sheet2);

  await page.reload();
  await expect(tabs.activeTab()).toHaveText("Sheet2");
  expect(tabs.urlSheetId()).toBe(sheet2);

  // Several tab switches later, Back leaves the workbook instead of replaying them.
  await tabs.open("Sheet1");
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Worksheet Clone" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

test("rename by double-click: duplicates are refused, a valid name reaches the server, no toast for yourself", async ({
  page,
}) => {
  const { tabs, toasts, serverNames, collab } = await open(page);
  await tabs.add();
  await tabs.expectNames(["Sheet1", "Sheet2"]);

  await tabs.tab("Sheet2").dblclick();
  await tabs.renameInput().fill("Sheet1");
  await tabs.renameInput().press("Enter");
  await expect(page.getByRole("alert")).toContainText("already exists");
  await expect(tabs.renameInput()).toBeVisible();
  await tabs.renameInput().press("Escape");
  await tabs.expectNames(["Sheet1", "Sheet2"]);

  await tabs.rename("Sheet2", "Budget");
  await tabs.expectNames(["Sheet1", "Budget"]);
  await expect.poll(serverNames).toEqual(["Sheet1", "Budget"]);

  // The server echoes a notice about our own rename to us as well; a remote
  // rename afterwards is ordered behind it, so exactly one toast (Bob's) means
  // ours was filtered.
  await collab.renameSheet(workbookId, await tabs.sheetId("Sheet1"), "Actuals");
  await expect(toasts).toHaveCount(1);
  await expect(toasts).toHaveText(/@bob renamed sheet "Sheet1" to "Actuals"/);
});

test("a remote rename updates the tab live and shows a toast that goes away", async ({ page }) => {
  const { tabs, toasts, collab } = await open(page);
  await tabs.add();
  await tabs.expectNames(["Sheet1", "Sheet2"]);

  await collab.renameSheet(workbookId, await tabs.sheetId("Sheet2"), "Budget");

  await tabs.expectNames(["Sheet1", "Budget"]);
  await expect(toasts).toHaveCount(1);
  await expect(toasts).toContainText('@bob renamed sheet "Sheet2" to "Budget"');
  await expect(toasts).toHaveAttribute("title", BOB.email);
  await expect(toasts).toHaveCount(0, { timeout: 10_000 });
});

test("a toast can be dismissed by hand", async ({ page }) => {
  const { tabs, toasts, collab } = await open(page);
  await collab.renameSheet(workbookId, await tabs.sheetId("Sheet1"), "Renamed");
  await expect(toasts).toHaveCount(1);
  await toasts.getByRole("button", { name: "Dismiss" }).click();
  await expect(toasts).toHaveCount(0);
});

test("reorder by dragging a tab; the server document follows", async ({ page }) => {
  const { tabs, serverNames } = await open(page);
  await addTwo(tabs);

  await tabs.drag("Sheet3", "Sheet1", "before");
  await tabs.expectNames(["Sheet3", "Sheet1", "Sheet2"]);
  await expect.poll(serverNames).toEqual(["Sheet3", "Sheet1", "Sheet2"]);

  await tabs.drag("Sheet3", "Sheet2", "after");
  await tabs.expectNames(["Sheet1", "Sheet2", "Sheet3"]);
  await expect.poll(serverNames).toEqual(["Sheet1", "Sheet2", "Sheet3"]);
});

test("hide a sheet and bring it back from the hidden-sheets menu", async ({ page }) => {
  const { tabs, collab } = await open(page);
  await tabs.add();
  await tabs.expectNames(["Sheet1", "Sheet2"]);
  const sheet2 = await tabs.sheetId("Sheet2");

  await tabs.chooseMenuItem("Sheet2", "hide");
  await tabs.expectNames(["Sheet1"]);
  await expect(tabs.hiddenButton()).toContainText("1");
  await expect
    .poll(() => {
      const doc = collab.serverDoc(workbookId);
      return doc ? isSheetHidden(doc, sheet2) : null;
    })
    .toBe(true);

  await tabs.hiddenButton().click();
  await tabs.hiddenItem("Sheet2").click();
  await tabs.expectNames(["Sheet1", "Sheet2"]);
  await expect(tabs.activeTab()).toHaveText("Sheet2");
  await expect(tabs.hiddenButton()).toHaveCount(0);
});

test("the last visible sheet can be neither hidden nor deleted", async ({ page }) => {
  const { tabs } = await open(page);
  await tabs.openMenu("Sheet1");
  await expect(tabs.menuItem("hide")).toBeDisabled();
  await expect(tabs.menuItem("delete")).toBeDisabled();
  await page.keyboard.press("Escape");

  // Hiding the other one leaves a single visible sheet again.
  await tabs.add();
  await tabs.chooseMenuItem("Sheet2", "hide");
  await tabs.expectNames(["Sheet1"]);
  await tabs.openMenu("Sheet1");
  await expect(tabs.menuItem("hide")).toBeDisabled();
  await expect(tabs.menuItem("delete")).toBeDisabled();
});

test("delete asks for confirmation and removes the sheet for everyone", async ({ page }) => {
  const { tabs, serverNames } = await open(page);
  await addTwo(tabs);

  await tabs.chooseMenuItem("Sheet2", "delete");
  await page.getByRole("button", { name: "Cancel" }).click();
  await tabs.expectNames(["Sheet1", "Sheet2", "Sheet3"]);

  await tabs.chooseMenuItem("Sheet2", "delete");
  await page.getByRole("button", { name: "Delete sheet" }).click();
  await tabs.expectNames(["Sheet1", "Sheet3"]);
  await expect.poll(serverNames).toEqual(["Sheet1", "Sheet3"]);
  // We deleted the sheet we were on: the neighbour takes over and the URL says so.
  await expect(tabs.activeTab()).toHaveText("Sheet3");
  await expect.poll(() => tabs.urlSheetId()).toBe(await tabs.sheetId("Sheet3"));
});

test("a collaborator deleting the sheet you're on moves you to its neighbour", async ({ page }) => {
  const { tabs, collab } = await open(page);
  await addTwo(tabs);
  await tabs.open("Sheet2");
  const sheet2 = await tabs.sheetId("Sheet2");
  await expect.poll(() => tabs.urlSheetId()).toBe(sheet2);

  await collab.remoteEdit(workbookId, (doc) => deleteSheet(doc, sheet2));

  await tabs.expectNames(["Sheet1", "Sheet3"]);
  await expect(tabs.activeTab()).toHaveText("Sheet3");
  await expect.poll(() => tabs.urlSheetId()).toBe(await tabs.sheetId("Sheet3"));
});

test("cross-sheet formulas follow edits, renames and deletion of the other sheet", async ({
  page,
}) => {
  const { tabs, grid, collab } = await open(page);
  await tabs.add();
  await tabs.expectNames(["Sheet1", "Sheet2"]);
  await grid.typeInto(0, 0, "5"); // Sheet2!A1
  await expect(grid.cell(0, 0)).toHaveText("5");
  const sheet2 = await tabs.sheetId("Sheet2");

  await tabs.open("Sheet1");
  await grid.typeInto(0, 0, "=Sheet2!A1*2");
  await expect(grid.cell(0, 0)).toHaveText("10");

  const ids = (doc: Y.Doc, sheetId: string) =>
    [sheetId, readRowOrder(doc, sheetId)[0]!, readColOrder(doc, sheetId)[0]!] as const;
  const remoteSetA1 = (data: CellData) =>
    collab.remoteEdit(workbookId, (doc) => setCell(doc, ...ids(doc, sheet2), data));
  const storedFormula = (): string | undefined => {
    const doc = collab.serverDoc(workbookId);
    const sheet1 = doc && readSheetOrder(doc)[0];
    return doc && sheet1 ? getCell(doc, ...ids(doc, sheet1))?.f : undefined;
  };

  await remoteSetA1({ v: 7 });
  await expect(grid.cell(0, 0)).toHaveText("14");

  // The stored formula refers to the sheet by id, so a rename keeps it alive
  // and the editor shows the new name.
  expect(storedFormula()).toBeTruthy();
  expect(storedFormula()).not.toContain("Sheet2");
  await collab.renameSheet(workbookId, sheet2, "Budget");
  await tabs.expectNames(["Sheet1", "Budget"]);
  await expect(grid.cell(0, 0)).toHaveText("14");
  await grid.clickCell(0, 0);
  await page.keyboard.press("F2");
  await expect(grid.editor()).toHaveValue("=Budget!A1*2");
  await page.keyboard.press("Escape");

  await collab.remoteEdit(workbookId, (doc) => deleteSheet(doc, sheet2));
  await tabs.expectNames(["Sheet1"]);
  await expect(grid.cell(0, 0)).toHaveText("#REF!");
});

test("a viewer can switch tabs but not add, rename or reorder", async ({ page }) => {
  const { tabs, collab } = await open(page, "readonly");
  await collab.remoteEdit(workbookId, (doc) => void addSheet(doc, "Sheet2"));
  await tabs.expectNames(["Sheet1", "Sheet2"]);

  await tabs.open("Sheet2");
  await expect(tabs.activeTab()).toHaveText("Sheet2");
  await expect.poll(() => tabs.urlSheetId()).toBe(await tabs.sheetId("Sheet2"));

  await expect(tabs.addButton()).toHaveCount(0);
  await tabs.tab("Sheet2").dblclick();
  await expect(tabs.renameInput()).toHaveCount(0);
  await tabs.tab("Sheet2").click({ button: "right" });
  await expect(page.getByTestId("sheet-menu")).toHaveCount(0);
  await tabs.drag("Sheet2", "Sheet1", "before");
  await tabs.expectNames(["Sheet1", "Sheet2"]);
});

test.describe("workbook header", () => {
  test("the owner renames the workbook inline; Escape cancels; no toast for yourself", async ({
    page,
  }) => {
    const { toasts, store, collab, tabs } = await open(page);
    const title = page.getByRole("heading", { level: 1 });
    await expect(title).toContainText(BOOK);

    await page.getByRole("button", { name: "Rename workbook" }).click();
    await page.getByLabel("Workbook name").fill("Discarded");
    await page.getByLabel("Workbook name").press("Escape");
    await expect(title).toContainText(BOOK);

    await page.getByRole("button", { name: "Rename workbook" }).click();
    await page.getByLabel("Workbook name").fill("Q4 budget");
    await page.getByLabel("Workbook name").press("Enter");
    await expect(title).toContainText("Q4 budget");
    expect(store.get(workbookId)?.summary.name).toBe("Q4 budget");

    // Bob's notice is ordered behind ours: one toast means ours was filtered.
    await collab.renameSheet(workbookId, await tabs.sheetId("Sheet1"), "Other");
    await expect(toasts).toHaveCount(1);
  });

  test("a collaborator renaming the workbook shows a toast and updates the header", async ({
    page,
  }) => {
    const { store, collab } = await open(page);
    const entry = store.get(workbookId);
    if (!entry) throw new Error("workbook missing from the mock");
    // What the server does for Bob's PATCH: store the name, then notify everyone.
    entry.summary = { ...entry.summary, name: "Q4 budget" };
    collab.broadcastWorkbookRenamed(workbookId, BOB, BOOK, "Q4 budget");

    await expect(page.getByTestId("toast")).toContainText(
      '@bob renamed the workbook "Q3 budget" to "Q4 budget"',
    );
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Q4 budget");
  });

  test("non-owners get plain text and no Share or Rename", async ({ page }) => {
    await open(page, "readonly");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(BOOK);
    await expect(page.getByText("Your role: viewer")).toBeVisible();
    await expect(page.getByRole("button", { name: "Rename workbook" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Share" })).toHaveCount(0);
  });

  test("owners open the members dialog with Share", async ({ page }) => {
    await open(page);
    await page.getByRole("button", { name: "Share" }).click();
    await expect(page.getByRole("dialog")).toContainText(BOOK);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
