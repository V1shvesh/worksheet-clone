import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { cellKey, getFormatsMap, readColOrder, readRowOrder } from "@worksheet-clone/shared";
import { createWorkbookUndo } from "../../../crdt/undo";
import { newDoc } from "../../../test-utils/workbook";
import type { IdSelection } from "../interaction/selection";
import { formatSelection, selectionCells, toggleFormat } from "./format-selection";

function sel(doc: Y.Doc, sheetId: string, a: [number, number], f: [number, number]): IdSelection {
  const rows = readRowOrder(doc, sheetId);
  const cols = readColOrder(doc, sheetId);
  return {
    anchor: { rowId: rows[a[0]]!, colId: cols[a[1]]! },
    focus: { rowId: rows[f[0]]!, colId: cols[f[1]]! },
  };
}
const fmt = (doc: Y.Doc, sheetId: string, r: number, c: number) =>
  getFormatsMap(doc, sheetId).get(
    cellKey(readRowOrder(doc, sheetId)[r]!, readColOrder(doc, sheetId)[c]!),
  );

describe("format selection", () => {
  it("covers the rectangle whichever corner is the anchor", () => {
    const { doc, sheetId } = newDoc();
    expect(selectionCells(doc, sheetId, sel(doc, sheetId, [3, 2], [1, 0]))).toHaveLength(9);
  });

  it("a whole column selection formats every row", () => {
    const { doc, sheetId } = newDoc();
    const t = { doc, readOnly: false };
    formatSelection(t, sheetId, sel(doc, sheetId, [0, 1], [99, 1]), { bg: "#fff2a8" });
    expect(fmt(doc, sheetId, 99, 1)).toEqual({ bg: "#fff2a8" });
    expect(fmt(doc, sheetId, 50, 0)).toBeUndefined();
    expect(getFormatsMap(doc, sheetId).size).toBe(100);
  });

  it("the active cell decides the toggle: un-bold all if it is bold, else bold all", () => {
    const { doc, sheetId } = newDoc();
    const t = { doc, readOnly: false };
    const range = sel(doc, sheetId, [0, 0], [1, 1]); // anchor A1
    formatSelection(t, sheetId, sel(doc, sheetId, [1, 1], [1, 1]), { b: true });
    // anchor not bold, another cell bold: everything becomes bold
    toggleFormat(t, sheetId, range, "b");
    expect([fmt(doc, sheetId, 0, 0), fmt(doc, sheetId, 1, 1)]).toEqual([{ b: true }, { b: true }]);
    // anchor bold now: everything loses it
    toggleFormat(t, sheetId, range, "b");
    expect(getFormatsMap(doc, sheetId).size).toBe(0);
  });

  it("one toggle over a range is one undo step", () => {
    const { doc, sheetId } = newDoc();
    const undo = createWorkbookUndo(doc, {
      isReadOnly: () => false,
      getContext: () => ({ sheetId, selection: null }),
    });
    toggleFormat({ doc, readOnly: false }, sheetId, sel(doc, sheetId, [0, 0], [4, 4]), "i");
    expect(getFormatsMap(doc, sheetId).size).toBe(25);
    undo.undo();
    expect(getFormatsMap(doc, sheetId).size).toBe(0);
    expect(undo.getState().canUndo).toBe(false);
    undo.redo();
    expect(getFormatsMap(doc, sheetId).size).toBe(25);
    undo.destroy();
  });

  it("is refused while read-only", () => {
    const { doc, sheetId } = newDoc();
    expect(
      toggleFormat({ doc, readOnly: true }, sheetId, sel(doc, sheetId, [0, 0], [0, 0]), "b"),
    ).toBe(false);
    expect(getFormatsMap(doc, sheetId).size).toBe(0);
  });
});
