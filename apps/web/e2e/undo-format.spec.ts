import { expect, test } from "@playwright/test";
import { BOB } from "./fixtures/collab";
import { openWorkbook } from "./fixtures/grid-workbook";

const workbookId = "00000000-0000-4000-8000-000000000061";

test("done-when: your undo never undoes a collaborator's edit, and redo brings yours back", async ({
  page,
}) => {
  const { grid, serverCell, remote } = await openWorkbook(page, workbookId);

  await grid.typeInto(0, 0, "mine A");
  await grid.typeInto(0, 1, "mine B");
  await expect.poll(() => serverCell(0, 1)).toEqual({ v: "mine B" });

  // Bob fills C1, then overwrites the B1 we wrote.
  await remote((set) => set(0, 2, { v: "bob C" }), BOB);
  await remote((set) => set(0, 1, { v: "bob B" }), BOB);
  await expect(grid.cell(0, 1)).toHaveText("bob B");
  await expect(grid.cell(0, 2)).toHaveText("bob C");

  await grid.clickCell(5, 5);
  await grid.chord("ControlOrMeta+z");
  await grid.chord("ControlOrMeta+z");

  await expect(grid.cell(0, 0)).toHaveText("");
  await expect(grid.cell(0, 1)).toHaveText("bob B");
  await expect(grid.cell(0, 2)).toHaveText("bob C");
  await expect.poll(() => serverCell(0, 0)).toBeUndefined();
  expect(serverCell(0, 1)).toEqual({ v: "bob B" });
  expect(serverCell(0, 2)).toEqual({ v: "bob C" });

  await grid.chord("ControlOrMeta+Shift+z");
  await expect(grid.cell(0, 0)).toHaveText("mine A");
  await expect.poll(() => serverCell(0, 0)).toEqual({ v: "mine A" });
  // Redo re-applies only yours: Bob's B1 still wins.
  await expect(grid.cell(0, 1)).toHaveText("bob B");
  expect(serverCell(0, 2)).toEqual({ v: "bob C" });

  // The toolbar buttons do the same.
  await grid.toolbarButton("Undo").click();
  await expect(grid.cell(0, 0)).toHaveText("");
  await grid.toolbarButton("Redo").click();
  await expect(grid.cell(0, 0)).toHaveText("mine A");
});

test("formatting a range is one update per action, persists on the server and undoes", async ({
  page,
}) => {
  const { grid, serverFormat, updates } = await openWorkbook(page, workbookId);
  await grid.dragSelect([0, 0], [1, 1]);

  const counter = updates();
  await grid.toolbarButton("Bold").click();
  await expect.poll(() => serverFormat(1, 1)).toEqual({ b: true });
  expect(counter.count).toBe(1);
  await expect(grid.toolbarButton("Bold")).toHaveAttribute("aria-pressed", "true");

  await grid.pickFillColor("Yellow");
  await expect.poll(() => serverFormat(1, 1)).toEqual({ b: true, bg: "#fff2a8" });
  expect(counter.count).toBe(2);
  for (const [r, c] of [
    [0, 0],
    [0, 1],
    [1, 0],
    [1, 1],
  ] as const) {
    expect(serverFormat(r, c)).toEqual({ b: true, bg: "#fff2a8" });
  }
  expect(serverFormat(2, 2)).toBeUndefined();

  // One undo per action: first the fill color, then the bold.
  await grid.toolbarButton("Undo").click();
  await expect.poll(() => serverFormat(1, 1)).toEqual({ b: true });
  await grid.toolbarButton("Undo").click();
  await expect.poll(() => serverFormat(1, 1)).toBeUndefined();
  expect(serverFormat(0, 0)).toBeUndefined();
  counter.stop();
});

test("Cmd/Ctrl+B decides by the active cell: bold off when it is bold, else on for all", async ({
  page,
}) => {
  const { grid, serverFormat } = await openWorkbook(page, workbookId);
  await grid.clickCell(1, 1);
  await grid.chord("ControlOrMeta+b"); // only B2 is bold now
  await expect.poll(() => serverFormat(1, 1)).toEqual({ b: true });

  // Active cell A1 (the anchor) is not bold, so the whole range becomes bold...
  await grid.dragSelect([0, 0], [1, 1]);
  await grid.chord("ControlOrMeta+b");
  await expect.poll(() => serverFormat(0, 0)).toEqual({ b: true });
  expect(serverFormat(1, 0)).toEqual({ b: true });
  // ...and now that the active cell is bold, the same chord turns it off everywhere.
  await grid.chord("ControlOrMeta+b");
  await expect.poll(() => serverFormat(0, 0)).toBeUndefined();
  expect(serverFormat(1, 1)).toBeUndefined();
});

test("viewers: toolbar disabled, no formatting chord effect", async ({ page }) => {
  const { grid, serverFormat } = await openWorkbook(page, workbookId, "readonly");
  await grid.clickCell(0, 0);
  for (const name of ["Undo", "Redo", "Bold", "Italic", "Underline", "Fill color"] as const) {
    await expect(grid.toolbarButton(name)).toBeDisabled();
  }
  await grid.chord("ControlOrMeta+b");
  await grid.chord("ControlOrMeta+z");
  expect(serverFormat(0, 0)).toBeUndefined();
});

test.describe("formula bar", () => {
  test("shows the active cell's formula; an edit there commits, Escape cancels", async ({
    page,
  }) => {
    const { grid, serverCell, remote } = await openWorkbook(page, workbookId);
    await remote((set) => {
      set(0, 0, { v: 4 });
      set(1, 0, { v: 5 });
    });
    await expect(grid.cell(1, 0)).toHaveText("5");
    await grid.typeInto(0, 1, "=A1*2");
    await expect(grid.cell(0, 1)).toHaveText("8");

    await grid.clickCell(0, 1);
    await expect(grid.formulaBar()).toHaveValue("=A1*2");
    await expect(grid.nameBox()).toHaveText("B1");

    // Edit in the bar: shows the draft, commits on Enter through the same path as the cell editor.
    await grid.formulaBar().click();
    await grid.formulaBar().fill("=A2*3");
    await expect(grid.formulaBar()).toHaveValue("=A2*3");
    // Nothing is written until the edit is committed.
    expect(JSON.stringify(serverCell(0, 1))).not.toContain("*3");
    await grid.formulaBar().press("Enter");
    await expect(grid.cell(0, 1)).toHaveText("15");
    await expect.poll(() => serverCell(0, 1)).toMatchObject({ f: expect.stringContaining("*3") });

    // Escape discards the draft.
    await grid.clickCell(0, 1);
    await grid.formulaBar().click();
    await grid.formulaBar().fill("=A2*100");
    await grid.formulaBar().press("Escape");
    await expect(grid.cell(0, 1)).toHaveText("15");
    await expect(grid.formulaBar()).toHaveValue("=A2*3");
  });

  test("a collaborator's change to the active cell shows up in the bar", async ({ page }) => {
    const { grid, remote } = await openWorkbook(page, workbookId);
    await grid.clickCell(2, 2);
    await expect(grid.formulaBar()).toHaveValue("");
    await remote((set) => set(2, 2, { v: "from bob" }), BOB);
    await expect(grid.formulaBar()).toHaveValue("from bob");
  });

  test("is read-only for viewers", async ({ page }) => {
    const { grid } = await openWorkbook(page, workbookId, "readonly");
    await grid.clickCell(0, 0);
    await expect(grid.formulaBar()).toHaveJSProperty("readOnly", true);
  });
});

test("undo after a sheet switch goes back to the sheet and the selection of that action", async ({
  page,
}) => {
  const { grid, tabs, serverCell } = await openWorkbook(page, workbookId);
  await tabs.add();
  await tabs.expectNames(["Sheet1", "Sheet2"]);
  const sheet1 = await tabs.sheetId("Sheet1");
  await tabs.open("Sheet1");

  await grid.clickCell(4, 3);
  await page.keyboard.type("on sheet one");
  await page.keyboard.press("Enter");
  await expect.poll(() => serverCell(4, 3, sheet1)).toEqual({ v: "on sheet one" });

  await tabs.open("Sheet2");
  await expect(tabs.activeTab()).toHaveText("Sheet2");
  await grid.clickCell(0, 0);
  await grid.chord("ControlOrMeta+z");

  await expect(tabs.activeTab()).toHaveText("Sheet1");
  expect(tabs.urlSheetId()).toBe(sheet1);
  await expect(grid.cell(4, 3)).toHaveText("");
  await expect.poll(() => serverCell(4, 3, sheet1)).toBeUndefined();
  await grid.expectActiveOn(4, 3);
  await expect(grid.nameBox()).toHaveText("D5");
});
