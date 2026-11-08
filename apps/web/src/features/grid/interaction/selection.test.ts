import { afterEach, describe, expect, it } from "vitest";
import { getColOrderArray, getRowOrderArray, newId } from "@worksheet-clone/shared";
import { resolveSelection, toIdSelection } from "./selection";
import { mountInteraction } from "./test-harness";

const mounted: ReturnType<typeof mountInteraction>[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.dispose();
});
function setup() {
  const m = mountInteraction();
  mounted.push(m);
  return m;
}

describe("selection id <-> index conversion", () => {
  it("round-trips indices through ids", () => {
    const { model } = setup();
    const sel = toIdSelection({ anchor: { row: 2, col: 1 }, focus: { row: 5, col: 3 } }, model)!;
    expect(sel.anchor).toEqual({ rowId: model.rowIdAt(2), colId: model.colIdAt(1) });
    const resolved = resolveSelection(sel, model)!;
    expect(resolved.anchor).toEqual({ row: 2, col: 1 });
    expect(resolved.focus).toEqual({ row: 5, col: 3 });
    expect(resolved.range).toEqual({ start: { row: 2, col: 1 }, end: { row: 5, col: 3 } });
  });

  it("returns null for out-of-grid coordinates and for no selection", () => {
    const { model } = setup();
    expect(
      toIdSelection({ anchor: { row: 0, col: 0 }, focus: { row: 999, col: 0 } }, model),
    ).toBeNull();
    expect(resolveSelection(null, model)).toBeNull();
  });

  it("follows the same cells when a row is inserted above", () => {
    const { doc, sheetId, model } = setup();
    const sel = toIdSelection({ anchor: { row: 1, col: 0 }, focus: { row: 3, col: 1 } }, model)!;
    doc.transact(() => getRowOrderArray(doc, sheetId).insert(0, [newId()]));
    const resolved = resolveSelection(sel, model)!;
    expect(resolved.range).toEqual({ start: { row: 2, col: 0 }, end: { row: 4, col: 1 } });
  });

  it("collapses onto the surviving endpoint when one endpoint's row is deleted", () => {
    const { doc, sheetId, model } = setup();
    const sel = toIdSelection({ anchor: { row: 1, col: 0 }, focus: { row: 4, col: 2 } }, model)!;
    doc.transact(() => getRowOrderArray(doc, sheetId).delete(4, 1));
    const resolved = resolveSelection(sel, model)!;
    // Rows collapse to the anchor's row; the columns are untouched.
    expect(resolved.range).toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 2 } });
  });

  it("collapses columns independently when the anchor column is deleted", () => {
    const { doc, sheetId, model } = setup();
    const sel = toIdSelection({ anchor: { row: 1, col: 1 }, focus: { row: 2, col: 3 } }, model)!;
    doc.transact(() => getColOrderArray(doc, sheetId).delete(1, 1));
    const resolved = resolveSelection(sel, model)!;
    expect(resolved.range).toEqual({ start: { row: 1, col: 2 }, end: { row: 2, col: 2 } });
  });

  it("resolves to null when both row endpoints are gone", () => {
    const { doc, sheetId, model } = setup();
    const sel = toIdSelection({ anchor: { row: 1, col: 0 }, focus: { row: 2, col: 0 } }, model)!;
    doc.transact(() => getRowOrderArray(doc, sheetId).delete(1, 2));
    expect(resolveSelection(sel, model)).toBeNull();
  });
});
