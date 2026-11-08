import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  getColWidthsMap,
  getRowHeightsMap,
  readColOrder,
  readRowOrder,
} from "@worksheet-clone/shared";
import { LOCAL_ORIGIN } from "../../../crdt/origin";
import { createWorkbookUndo } from "../../../crdt/undo";
import { mountInteraction } from "./test-harness";

const mounted: ReturnType<typeof mountInteraction>[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.dispose();
});

function setup(opts: Parameters<typeof mountInteraction>[0] = {}) {
  const m = mountInteraction(opts);
  mounted.push(m);
  const txs: unknown[] = [];
  m.doc.on("afterTransaction", (tr: Y.Transaction) => {
    if (tr.changed.size > 0) txs.push(tr.origin);
  });
  const colId = (i: number) => readColOrder(m.doc, m.sheetId)[i]!;
  const rowId = (i: number) => readRowOrder(m.doc, m.sheetId)[i]!;
  return { ...m, txs, colId, rowId };
}

describe("column resize (port columnResized event)", () => {
  it("writes the width of that column in one LOCAL_ORIGIN transaction and the grid follows", () => {
    const t = setup();
    t.view.columnResized(2, 180);
    expect(getColWidthsMap(t.doc, t.sheetId).get(t.colId(2))).toBe(180);
    expect(getColWidthsMap(t.doc, t.sheetId).size).toBe(1);
    expect(t.txs).toEqual([LOCAL_ORIGIN]);
    expect(t.view.getCellRect({ row: 0, col: 2 })!.width).toBe(180);
    // The columns after it moved right by the difference.
    expect(t.view.getCellRect({ row: 0, col: 3 })!.x).toBe(
      t.view.getCellRect({ row: 0, col: 2 })!.x + 180,
    );
  });

  it("clamps to 20..1000", () => {
    const t = setup();
    t.view.columnResized(0, 5);
    expect(getColWidthsMap(t.doc, t.sheetId).get(t.colId(0))).toBe(20);
    t.view.columnResized(0, 5000);
    expect(getColWidthsMap(t.doc, t.sheetId).get(t.colId(0))).toBe(1000);
  });

  it("is one undo step, and redo restores it", () => {
    const t = setup();
    const history = createWorkbookUndo(t.doc, {
      isReadOnly: () => false,
      getContext: () => ({ sheetId: t.sheetId, selection: null }),
    });
    t.view.columnResized(1, 220);
    history.undo();
    expect(getColWidthsMap(t.doc, t.sheetId).has(t.colId(1))).toBe(false);
    expect(t.view.getCellRect({ row: 0, col: 1 })!.width).toBe(100);
    history.redo();
    expect(getColWidthsMap(t.doc, t.sheetId).get(t.colId(1))).toBe(220);
    history.destroy();
  });

  it("is refused for a viewer: nothing is written and the grid is reset to the stored width", () => {
    const t = setup({ readOnly: true });
    // The adapter's own gesture already changed what it shows; model it by resizing the view.
    const dims = t.model.dimensions();
    t.view.setDimensions({ ...dims, colWidth: (c) => (c === 2 ? 250 : dims.colWidth(c)) });
    expect(t.view.getCellRect({ row: 0, col: 2 })!.width).toBe(250);
    t.view.columnResized(2, 250);
    expect(t.txs).toEqual([]);
    expect(getColWidthsMap(t.doc, t.sheetId).size).toBe(0);
    expect(t.view.getCellRect({ row: 0, col: 2 })!.width).toBe(100);
  });

  it("shows a collaborator's width change live", () => {
    const t = setup();
    getColWidthsMap(t.doc, t.sheetId).set(t.colId(0), 300);
    expect(t.view.getCellRect({ row: 0, col: 0 })!.width).toBe(300);
  });
});

describe("row resize (overlay -> controller)", () => {
  it("writes the height of that row in one LOCAL_ORIGIN transaction and the grid follows", () => {
    const t = setup();
    expect(t.interaction.resizeRow(3, 60)).toBe(true);
    expect(getRowHeightsMap(t.doc, t.sheetId).get(t.rowId(3))).toBe(60);
    expect(t.txs).toEqual([LOCAL_ORIGIN]);
    expect(t.view.getCellRect({ row: 3, col: 0 })!.height).toBe(60);
    expect(t.view.getCellRect({ row: 4, col: 0 })!.y).toBe(
      t.view.getCellRect({ row: 3, col: 0 })!.y + 60,
    );
  });

  it("clamps to 16..500 and undoes in one step", () => {
    const t = setup();
    const history = createWorkbookUndo(t.doc, {
      isReadOnly: () => false,
      getContext: () => ({ sheetId: t.sheetId, selection: null }),
    });
    t.interaction.resizeRow(0, 2);
    expect(getRowHeightsMap(t.doc, t.sheetId).get(t.rowId(0))).toBe(16);
    t.interaction.resizeRow(0, 9999);
    expect(getRowHeightsMap(t.doc, t.sheetId).get(t.rowId(0))).toBe(500);
    history.undo();
    expect(getRowHeightsMap(t.doc, t.sheetId).get(t.rowId(0))).toBe(16);
    history.undo();
    expect(getRowHeightsMap(t.doc, t.sheetId).has(t.rowId(0))).toBe(false);
    history.destroy();
  });

  it("is refused for a viewer and for a row that does not exist", () => {
    const viewer = setup({ readOnly: true });
    expect(viewer.interaction.resizeRow(1, 50)).toBe(false);
    expect(viewer.txs).toEqual([]);
    const editor = setup();
    expect(editor.interaction.resizeRow(9999, 50)).toBe(false);
    expect(editor.txs).toEqual([]);
  });
});
