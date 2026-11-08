import { afterEach, describe, expect, it } from "vitest";
import { DetailedCellError } from "hyperformula";
import {
  MAX_COL_COUNT,
  MAX_ROW_COUNT,
  addSheet,
  getCell,
  getRowOrderArray,
  readColOrder,
  readRowOrder,
} from "@worksheet-clone/shared";
import { createWorkbookUndo } from "../../../crdt/undo";
import { LOCAL_ORIGIN } from "../../../crdt/origin";
import { edit } from "../../../test-utils/workbook";
import { mountInteraction } from "../interaction/test-harness";
import { createStructureActions } from "./structure-actions";

const mounted: { undo: { destroy(): void }; dispose(): void }[] = [];
afterEach(() => {
  while (mounted.length > 0) {
    const m = mounted.pop()!;
    m.undo.destroy();
    m.dispose();
  }
});

function setup(opts: { readOnly?: boolean } = {}) {
  const m = mountInteraction({ readOnly: opts.readOnly ?? false });
  const undo = createWorkbookUndo(m.doc, {
    isReadOnly: () => m.target.readOnly,
    getContext: () => ({ sheetId: m.sheetId, selection: null }),
  });
  const actions = createStructureActions({
    doc: m.doc,
    sheetId: m.sheetId,
    dispatch: m.store.dispatch,
    isReadOnly: () => m.target.readOnly,
  });
  const origins: unknown[] = [];
  m.doc.on("afterTransaction", (tr) => {
    if (tr.changed.size > 0) origins.push(tr.origin);
  });
  const out = {
    ...m,
    undo,
    actions,
    origins,
    raw: (row: number, col: number) => m.model.getRawInput({ row, col }),
    shown: (row: number, col: number) => m.model.getCell({ row, col }).text,
    sel: () => m.store.getState().grid.selection,
    toasts: () => m.store.getState().toasts.items.map((t) => t.message),
  };
  mounted.push(out);
  return out;
}

describe("insertRows / insertCols", () => {
  it("inserts N rows above or below in one LOCAL_ORIGIN transaction", () => {
    const t = setup();
    edit(t.doc, t.sheetId, 2, 0, { v: "x" });
    const before = readRowOrder(t.doc, t.sheetId);
    t.origins.length = 0;
    t.actions.insertRows(2, 3);
    const after = readRowOrder(t.doc, t.sheetId);
    expect(after).toHaveLength(before.length + 3);
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after.slice(5)).toEqual(before.slice(2));
    expect(t.origins).toEqual([LOCAL_ORIGIN]);
    expect(t.model.dimensions().rowCount).toBe(before.length + 3);
    expect(t.shown(5, 0)).toBe("x");
    expect(t.shown(2, 0)).toBe("");
  });

  it("selects the new whole rows (and whole columns for columns)", () => {
    const t = setup();
    t.actions.insertRows(4, 2);
    const rows = readRowOrder(t.doc, t.sheetId);
    const cols = readColOrder(t.doc, t.sheetId);
    expect(t.sel()).toEqual({
      anchor: { rowId: rows[4], colId: cols[0] },
      focus: { rowId: rows[5], colId: cols[cols.length - 1] },
    });
    t.actions.insertCols(1, 1);
    const rows2 = readRowOrder(t.doc, t.sheetId);
    const cols2 = readColOrder(t.doc, t.sheetId);
    expect(t.sel()).toEqual({
      anchor: { rowId: rows2[0], colId: cols2[1] },
      focus: { rowId: rows2[rows2.length - 1], colId: cols2[1] },
    });
  });

  it("columns insert left and right of a cell; headers renumber", () => {
    const t = setup();
    edit(t.doc, t.sheetId, 0, 1, { v: "b" });
    t.actions.insertCols(1, 1); // left of B
    expect(t.shown(0, 2)).toBe("b");
    t.actions.insertCols(3, 2); // right of the moved B
    expect(t.shown(0, 2)).toBe("b");
    expect(t.model.dimensions().colCount).toBe(26 + 3);
    expect(t.model.dimensions().colLabel(28)).toBe("AC");
  });

  it("formulas follow: inserting inside a range grows it, below it moves the cell", () => {
    const t = setup();
    for (let r = 0; r < 3; r++) edit(t.doc, t.sheetId, r, 0, { v: r + 1 });
    edit(t.doc, t.sheetId, 5, 1, { f: "=SUM(A1:A3)" });
    edit(t.doc, t.sheetId, 6, 1, { f: "=A3" });
    expect(t.shown(5, 1)).toBe("6");
    t.actions.insertRows(2, 1); // inside the range
    expect(t.raw(6, 1)).toBe("=SUM(A1:A4)");
    expect(t.raw(7, 1)).toBe("=A4");
    expect(t.shown(6, 1)).toBe("6");
    t.actions.insertRows(0, 2); // above everything
    expect(t.raw(8, 1)).toBe("=SUM(A3:A6)");
    expect(t.shown(8, 1)).toBe("6");
  });

  it("cross-sheet references follow an insert on the referenced sheet", () => {
    const t = setup();
    let other = "";
    t.doc.transact(() => {
      other = addSheet(t.doc, "Data");
    });
    edit(t.doc, other, 3, 0, { v: 7 });
    edit(t.doc, t.sheetId, 0, 0, { f: "=Data!A4" });
    expect(t.shown(0, 0)).toBe("7");
    const onData = createStructureActions({
      doc: t.doc,
      sheetId: other,
      dispatch: t.store.dispatch,
      isReadOnly: () => false,
    });
    onData.insertRows(0, 2);
    expect(t.raw(0, 0)).toBe("=Data!A6");
    expect(t.shown(0, 0)).toBe("7");
  });

  it("is one undo step that removes the inserted rows again", () => {
    const t = setup();
    edit(t.doc, t.sheetId, 4, 0, { v: 1 });
    edit(t.doc, t.sheetId, 5, 0, { f: "=A5" });
    const before = readRowOrder(t.doc, t.sheetId);
    t.actions.insertRows(0, 2);
    expect(readRowOrder(t.doc, t.sheetId)).toHaveLength(before.length + 2);
    expect(t.undo.undo()).not.toBeNull();
    expect(readRowOrder(t.doc, t.sheetId)).toEqual(before);
    expect(t.raw(5, 0)).toBe("=A5");
    expect(t.undo.getState().canUndo).toBe(false);
  });

  it("refuses viewers: nothing written, no transaction", () => {
    const t = setup({ readOnly: true });
    t.actions.insertRows(0, 1);
    t.actions.insertCols(0, 1);
    t.actions.deleteRows([readRowOrder(t.doc, t.sheetId)[0]!]);
    t.actions.deleteCols([readColOrder(t.doc, t.sheetId)[0]!]);
    expect(t.origins).toEqual([]);
    expect(t.model.dimensions()).toMatchObject({ rowCount: 100, colCount: 26 });
    expect(t.sel()).toBeNull();
  });

  it("refuses past the caps with a toast and writes nothing", () => {
    const t = setup();
    t.doc.transact(() => {
      getRowOrderArray(t.doc, t.sheetId).push(
        Array.from({ length: MAX_ROW_COUNT - 100 }, (_, i) => `fill${i}`),
      );
    });
    t.origins.length = 0;
    t.actions.insertRows(0, 1);
    expect(t.origins).toEqual([]);
    expect(t.toasts()).toEqual(["A sheet can have at most 10,000 rows"]);
    expect(readRowOrder(t.doc, t.sheetId)).toHaveLength(MAX_ROW_COUNT);

    t.actions.insertCols(0, MAX_COL_COUNT);
    expect(t.toasts().at(-1)).toBe("A sheet can have at most 500 columns");
    expect(t.origins).toEqual([]);
    expect(readColOrder(t.doc, t.sheetId)).toHaveLength(26);
  });
});

describe("deleteRows / deleteCols", () => {
  const rowIds = (t: ReturnType<typeof setup>, ...i: number[]) =>
    i.map((n) => readRowOrder(t.doc, t.sheetId)[n]!);

  it("removes the rows with their cells in one transaction and selects the row now at that index", () => {
    const t = setup();
    edit(t.doc, t.sheetId, 2, 0, { v: "gone" });
    edit(t.doc, t.sheetId, 4, 0, { v: "stays" });
    const before = readRowOrder(t.doc, t.sheetId);
    t.origins.length = 0;
    t.actions.deleteRows(rowIds(t, 2, 3));
    expect(t.origins).toEqual([LOCAL_ORIGIN]);
    const after = readRowOrder(t.doc, t.sheetId);
    expect(after).toHaveLength(before.length - 2);
    expect(
      getCell(t.doc, t.sheetId, before[2]!, readColOrder(t.doc, t.sheetId)[0]!),
    ).toBeUndefined();
    expect(t.shown(2, 0)).toBe("stays");
    const cols = readColOrder(t.doc, t.sheetId);
    expect(t.sel()).toEqual({
      anchor: { rowId: after[2], colId: cols[0] },
      focus: { rowId: after[2], colId: cols[cols.length - 1] },
    });
  });

  it("deleting the last rows selects the new last row (clamped)", () => {
    const t = setup();
    t.actions.deleteRows(rowIds(t, 98, 99));
    const after = readRowOrder(t.doc, t.sheetId);
    expect(t.sel()?.anchor.rowId).toBe(after[after.length - 1]);
  });

  it("Excel shrink: deleting the last row of a range shrinks it", () => {
    const t = setup();
    for (let r = 0; r < 3; r++) edit(t.doc, t.sheetId, r, 0, { v: r + 1 });
    edit(t.doc, t.sheetId, 0, 1, { f: "=SUM(A1:A3)" });
    expect(t.shown(0, 1)).toBe("6");
    t.actions.deleteRows(rowIds(t, 2));
    expect(t.raw(0, 1)).toBe("=SUM(A1:A2)");
    expect(t.shown(0, 1)).toBe("3");
  });

  it("a single-cell reference to a deleted row becomes #REF!", () => {
    const t = setup();
    edit(t.doc, t.sheetId, 2, 0, { v: 5 });
    edit(t.doc, t.sheetId, 0, 1, { f: "=A3+1" });
    t.actions.deleteRows(rowIds(t, 2));
    expect(t.raw(0, 1)).toContain("#REF!");
    expect(t.model.getCell({ row: 0, col: 1 }).error).toBe(true);
    expect(t.shown(0, 1)).toBe("#REF!");
    expect(t.engine.getValue(t.sheetId, 0, 1)).toBeInstanceOf(DetailedCellError);
  });

  it("columns: delete shifts the others left and shrinks ranges across sheets", () => {
    const t = setup();
    let other = "";
    t.doc.transact(() => {
      other = addSheet(t.doc, "Data");
    });
    for (let c = 0; c < 3; c++) edit(t.doc, t.sheetId, 0, c, { v: c + 1 });
    edit(t.doc, other, 0, 0, { f: "=SUM(Sheet1!A1:C1)" });
    const cols = readColOrder(t.doc, t.sheetId);
    t.actions.deleteCols([cols[2]!]);
    expect(t.shown(0, 2)).toBe("");
    expect(t.model.dimensions().colCount).toBe(25);
    const crossSheet = getCell(
      t.doc,
      other,
      readRowOrder(t.doc, other)[0]!,
      readColOrder(t.doc, other)[0]!,
    );
    expect(crossSheet?.f).toBeDefined();
    expect(t.engine.getValue(other, 0, 0)).toBe(3); // SUM(Sheet1!A1:B1), shrunk from A1:C1
    t.actions.deleteCols([cols[0]!]);
    expect(t.shown(0, 0)).toBe("2");
  });

  it("is one undo step restoring cells and formulas", () => {
    const t = setup();
    for (let r = 0; r < 3; r++) edit(t.doc, t.sheetId, r, 0, { v: r + 1 });
    edit(t.doc, t.sheetId, 0, 1, { f: "=SUM(A1:A3)" });
    const before = readRowOrder(t.doc, t.sheetId);
    t.actions.deleteRows(rowIds(t, 2));
    expect(t.raw(0, 1)).toBe("=SUM(A1:A2)");
    expect(t.undo.undo()).not.toBeNull();
    expect(readRowOrder(t.doc, t.sheetId)).toEqual(before);
    expect(t.shown(2, 0)).toBe("3");
    expect(t.raw(0, 1)).toBe("=SUM(A1:A3)");
    expect(t.shown(0, 1)).toBe("6");
    expect(t.undo.redo()).not.toBeNull();
    expect(t.raw(0, 1)).toBe("=SUM(A1:A2)");
  });

  it("refuses to delete every row or column and unknown ids; nothing is written", () => {
    const t = setup();
    t.origins.length = 0;
    t.actions.deleteRows(readRowOrder(t.doc, t.sheetId));
    t.actions.deleteCols(readColOrder(t.doc, t.sheetId));
    t.actions.deleteRows(["nope"]);
    expect(t.origins).toEqual([]);
    expect(t.model.dimensions()).toMatchObject({ rowCount: 100, colCount: 26 });
    expect(t.undo.getState().canUndo).toBe(false);
  });
});
