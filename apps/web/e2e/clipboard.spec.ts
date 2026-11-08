import { expect, test } from "@playwright/test";
import { BOB } from "./fixtures/collab";
import { clipboardPermissions, openWorkbook } from "./fixtures/grid-workbook";

const workbookId = "00000000-0000-4000-8000-000000000063";

// Real Cmd/Ctrl+C/X/V presses against the browser's real clipboard (granted to the context).
test.use({ permissions: clipboardPermissions });

test("copy puts displayed values on text/plain and a table of displayed values on text/html", async ({
  page,
}) => {
  const { grid, remote } = await openWorkbook(page, workbookId);
  await remote((set) => {
    set(0, 0, { v: 3 });
    set(0, 1, { v: "a\tb" });
    set(1, 0, { v: 1 });
  }, BOB);
  await expect(grid.cell(1, 0)).toHaveText("1");
  await grid.typeInto(1, 1, "=A1/0");
  await expect(grid.cell(1, 1)).toHaveText("#DIV/0!");

  await grid.dragSelect([0, 0], [1, 1]);
  await grid.chord("ControlOrMeta+c");

  await expect.poll(async () => (await grid.readClipboard()).text).toBe('3\t"a\tb"\n1\t#DIV/0!');
  const { html } = await grid.readClipboard();
  expect(html).toContain("<td>#DIV/0!</td>");
  expect(html).not.toContain("<td>=A1/0</td>");
  // our raw input rides along for pasting back into the app
  expect(html).toContain("data-worksheet-clip");
});

test("paste our own copy: formulas shift, one Yjs update per paste", async ({ page }) => {
  const { grid, serverCell, remote, updates } = await openWorkbook(page, workbookId);
  await remote((set) => set(0, 0, { v: 7 }), BOB);
  await expect(grid.cell(0, 0)).toHaveText("7");
  await grid.typeInto(0, 1, "=A1*2");
  await grid.typeInto(1, 0, "x");
  await expect(grid.cell(0, 1)).toHaveText("14");

  await grid.dragSelect([0, 0], [1, 1]);
  await grid.chord("ControlOrMeta+c");
  await expect.poll(async () => (await grid.readClipboard()).text).toContain("14");

  const counter = updates();
  await grid.clickCell(4, 3);
  await grid.chord("ControlOrMeta+v");

  await expect(grid.cell(4, 3)).toHaveText("7");
  await expect(grid.cell(5, 3)).toHaveText("x");
  // The pasted formula points at the pasted 7, not at the original A1.
  await expect(grid.cell(4, 4)).toHaveText("14");
  await grid.clickCell(4, 4);
  await expect(grid.formulaBar()).toHaveValue("=D5*2");
  await expect.poll(() => serverCell(4, 4)).toMatchObject({ f: expect.any(String) });
  expect(counter.count).toBe(1);
  // The pasted block is selected.
  await grid.dragSelect([4, 3], [5, 4]);
  await grid.expectSelectionOver([4, 3], [5, 4]);

  // Undo removes the whole paste.
  await grid.chord("ControlOrMeta+z");
  await expect(grid.cell(4, 3)).toHaveText("");
  await expect(grid.cell(5, 4)).toHaveText("");
  expect(counter.count).toBe(2);
  counter.stop();
});

test("paste external text: tabs, quoted cells with a tab, numbers and formulas as typed", async ({
  page,
}) => {
  const { grid, serverCell, updates } = await openWorkbook(page, workbookId);
  await grid.typeInto(0, 0, "10");
  await grid.writeClipboard('name\t"has\ttab"\n007\t=A1+1\n\tlast\n');

  const counter = updates();
  await grid.clickCell(2, 2);
  await grid.chord("ControlOrMeta+v");

  await expect(grid.cell(2, 2)).toHaveText("name");
  await expect(grid.cell(2, 3)).toHaveText("has\ttab");
  await expect(grid.cell(3, 2)).toHaveText("7");
  await expect(grid.cell(3, 3)).toHaveText("11");
  await expect(grid.cell(4, 2)).toHaveText("");
  await expect(grid.cell(4, 3)).toHaveText("last");
  expect(serverCell(2, 3)).toEqual({ v: "has\ttab" });
  expect(serverCell(3, 2)).toEqual({ v: 7 });
  expect(serverCell(3, 3)).toMatchObject({ f: expect.any(String) });
  expect(counter.count).toBe(1);
  counter.stop();
});

test("a single copied cell fills the whole selected range", async ({ page }) => {
  const { grid, updates } = await openWorkbook(page, workbookId);
  await grid.typeInto(0, 0, "fill");
  await grid.clickCell(0, 0);
  await grid.chord("ControlOrMeta+c");
  await grid.dragSelect([2, 2], [3, 3]);
  const counter = updates();
  await grid.chord("ControlOrMeta+v");
  for (const [r, c] of [
    [2, 2],
    [2, 3],
    [3, 2],
    [3, 3],
  ] as const) {
    await expect(grid.cell(r, c)).toHaveText("fill");
  }
  expect(counter.count).toBe(1);
  counter.stop();
});

test("cut marks the source, paste moves it: formulas unchanged, source empty, one update", async ({
  page,
}) => {
  const { grid, serverCell, serverFormat, remote, updates } = await openWorkbook(page, workbookId);
  await remote((set) => set(0, 0, { v: 20 }), BOB);
  await expect(grid.cell(0, 0)).toHaveText("20");
  await grid.typeInto(0, 1, "=A1+1"); // B1 refers to A1
  await grid.clickCell(0, 1);
  await grid.toolbarButton("Italic").click();
  await expect(grid.cell(0, 1)).toHaveText("21");
  const before = serverCell(0, 1);
  expect(before).toMatchObject({ f: expect.any(String) });

  await grid.clickCell(0, 1);
  await grid.chord("ControlOrMeta+x");
  await expect(grid.cutRect()).toBeVisible();
  await expect(grid.cell(0, 1)).toHaveText("21"); // not removed until pasted

  const counter = updates();
  await grid.clickCell(2, 2);
  await grid.chord("ControlOrMeta+v");

  await expect(grid.cell(2, 2)).toHaveText("21");
  await expect(grid.cell(0, 1)).toHaveText("");
  await expect(grid.cutRect()).toHaveCount(0);
  await grid.clickCell(2, 2);
  await expect(grid.formulaBar()).toHaveValue("=A1+1"); // not shifted
  // the stored (id-based) formula is byte-for-byte the one that was cut
  expect(serverCell(2, 2)).toEqual(before);
  expect(serverCell(0, 1)).toBeUndefined();
  expect(serverFormat(2, 2)).toEqual({ i: true });
  expect(serverFormat(0, 1)).toBeUndefined();
  expect(counter.count).toBe(1);

  // Undo puts everything back in one step.
  await grid.chord("ControlOrMeta+z");
  await expect(grid.cell(0, 1)).toHaveText("21");
  await expect(grid.cell(2, 2)).toHaveText("");
  counter.stop();
});

test("Escape drops the cut mark and a later paste is a plain copy", async ({ page }) => {
  const { grid } = await openWorkbook(page, workbookId);
  await grid.typeInto(0, 0, "keep");
  await grid.clickCell(0, 0);
  await grid.chord("ControlOrMeta+x");
  await expect(grid.cutRect()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(grid.cutRect()).toHaveCount(0);

  await grid.clickCell(3, 3);
  await grid.chord("ControlOrMeta+v");
  await expect(grid.cell(3, 3)).toHaveText("keep");
  await expect(grid.cell(0, 0)).toHaveText("keep"); // the source stayed
});

test("cut on one sheet pastes onto another: formulas still point at the source sheet", async ({
  page,
}) => {
  const { grid, tabs } = await openWorkbook(page, workbookId);
  await grid.typeInto(0, 0, "5");
  await grid.typeInto(0, 1, "=A1*3");
  await expect(grid.cell(0, 1)).toHaveText("15");
  await tabs.add();
  await tabs.expectNames(["Sheet1", "Sheet2"]);
  await tabs.open("Sheet1");

  await grid.clickCell(0, 1);
  await grid.chord("ControlOrMeta+x");
  await tabs.open("Sheet2");
  await grid.clickCell(1, 1);
  await grid.chord("ControlOrMeta+v");

  await expect(grid.cell(1, 1)).toHaveText("15");
  await grid.clickCell(1, 1);
  await expect(grid.formulaBar()).toHaveValue("=Sheet1!A1*3");
  await tabs.open("Sheet1");
  await expect(grid.cell(0, 1)).toHaveText("");
});

test("pasting past the sheet's edge cuts the data and says so", async ({ page }) => {
  const { grid, serverCell, updates } = await openWorkbook(page, workbookId);
  await grid.writeClipboard("1\t2\t3\n4\t5\t6\n7\t8\t9");
  // Cell Y98 (97, 24) is far below the viewport: walk there with the keyboard.
  await grid.clickCell(0, 0);
  for (let i = 0; i < 97; i++) await page.keyboard.press("ArrowDown");
  for (let i = 0; i < 24; i++) await page.keyboard.press("ArrowRight");
  await expect(grid.nameBox()).toHaveText("Y98");

  const counter = updates();
  await grid.chord("ControlOrMeta+v");
  await expect(grid.toasts()).toContainText("Pasted data was cut to fit the sheet");
  await expect.poll(() => serverCell(97, 24)).toEqual({ v: 1 });
  expect(serverCell(97, 25)).toEqual({ v: 2 });
  expect(serverCell(99, 25)).toEqual({ v: 8 });
  expect(serverCell(99, 24)).toEqual({ v: 7 });
  expect(counter.count).toBe(1);
  counter.stop();
});

test("viewers: paste, cut and fill do nothing, copy still works", async ({ page }) => {
  const { grid, serverCell, remote, updates } = await openWorkbook(page, workbookId, "readonly");
  await remote((set) => set(0, 0, { v: "bob" }), BOB);
  await expect(grid.cell(0, 0)).toHaveText("bob");
  await grid.clickCell(0, 0);
  await grid.chord("ControlOrMeta+c");
  await expect.poll(async () => (await grid.readClipboard()).text).toBe("bob");
  await expect(grid.fillHandle()).toHaveCount(0);

  const counter = updates();
  await grid.clickCell(2, 2);
  await grid.chord("ControlOrMeta+v");
  await grid.writeClipboard("external");
  await grid.chord("ControlOrMeta+v");
  await grid.clickCell(0, 0);
  await grid.chord("ControlOrMeta+x");
  await expect(grid.cutRect()).toHaveCount(0);
  await expect(grid.cell(2, 2)).toHaveText("");
  await expect(grid.cell(0, 0)).toHaveText("bob");
  expect(serverCell(2, 2)).toBeUndefined();
  expect(counter.count).toBe(0);
  counter.stop();
});

test("native text copy and paste still work in the formula bar and cell editor", async ({
  page,
}) => {
  const { grid } = await openWorkbook(page, workbookId);
  await grid.typeInto(0, 0, "hello");
  await grid.writeClipboard("pasted text");

  // In the formula bar: Cmd+V pastes into the draft, not into the grid.
  await grid.clickCell(1, 0);
  await grid.formulaBar().click();
  await grid.chord("ControlOrMeta+v");
  await expect(grid.formulaBar()).toHaveValue("pasted text");
  await grid.formulaBar().press("Escape");

  // In the cell editor: select-all + copy copies the text being edited.
  await grid.clickCell(0, 0);
  await page.keyboard.press("F2");
  await expect(grid.editor()).toHaveValue("hello");
  await grid.chord("ControlOrMeta+a");
  await grid.chord("ControlOrMeta+c");
  await expect.poll(async () => (await grid.readClipboard()).text).toBe("hello");
  await page.keyboard.press("Escape");
  await expect(grid.cell(1, 0)).toHaveText("");
});
