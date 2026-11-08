import { afterEach, describe, expect, it } from "vitest";
import { getRowOrderArray, newId } from "@worksheet-clone/shared";
import { resolveSelection } from "./selection";
import { mountInteraction } from "./test-harness";

const mounted: ReturnType<typeof mountInteraction>[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.dispose();
});
function setup() {
  const m = mountInteraction();
  mounted.push(m);
  const range = () => {
    const r = resolveSelection(m.store.getState().grid.selection, m.model);
    return r && r.range;
  };
  const sel = () => resolveSelection(m.store.getState().grid.selection, m.model);
  return { ...m, range, sel };
}

const cell = (row: number, col: number) => ({ row, col });

describe("pointer interaction", () => {
  it("clicking a cell selects it and focuses the grid", () => {
    const { view, range } = setup();
    view.pointerDown(cell(2, 3));
    view.pointerUp(cell(2, 3));
    expect(range()).toEqual({ start: cell(2, 3), end: cell(2, 3) });
    expect(view.focusCount).toBe(1);
  });

  it("shift+click extends from the anchor and keeps the anchor", () => {
    const { view, sel } = setup();
    view.pointerDown(cell(2, 2));
    view.pointerUp(cell(2, 2));
    view.pointerDown(cell(5, 4), { shiftKey: true });
    view.pointerUp(cell(5, 4));
    expect(sel()!.range).toEqual({ start: cell(2, 2), end: cell(5, 4) });
    view.pointerDown(cell(0, 0), { shiftKey: true });
    view.pointerUp(cell(0, 0));
    expect(sel()!.anchor).toEqual(cell(2, 2));
    expect(sel()!.range).toEqual({ start: cell(0, 0), end: cell(2, 2) });
  });

  it("dragging extends the range, and moves after pointerUp are ignored", () => {
    const { view, range } = setup();
    view.pointerDown(cell(1, 1));
    view.pointerMove(cell(2, 1));
    view.pointerMove(cell(3, 3));
    expect(range()).toEqual({ start: cell(1, 1), end: cell(3, 3) });
    view.pointerUp(cell(3, 3));
    view.pointerMove(cell(8, 8));
    expect(range()).toEqual({ start: cell(1, 1), end: cell(3, 3) });
  });

  it("moves without a preceding pointerDown do nothing", () => {
    const { view, store } = setup();
    view.pointerMove(cell(3, 3));
    expect(store.getState().grid.selection).toBeNull();
  });

  it("dragging back over the anchor shrinks the range", () => {
    const { view, range } = setup();
    view.pointerDown(cell(4, 4));
    view.pointerMove(cell(6, 6));
    view.pointerMove(cell(3, 3));
    expect(range()).toEqual({ start: cell(3, 3), end: cell(4, 4) });
  });

  it("ignores non-primary buttons on pointerDown", () => {
    const { view, store } = setup();
    view.pointerDown(cell(1, 1), { button: 2 });
    expect(store.getState().grid.selection).toBeNull();
  });

  it("column header selects the whole column; shift+header extends columns", () => {
    const { view, range, model } = setup();
    const lastRow = model.dimensions().rowCount - 1;
    view.pointerDown({ kind: "colHeader", col: 2 });
    view.pointerUp({ kind: "colHeader", col: 2 });
    expect(range()).toEqual({ start: cell(0, 2), end: cell(lastRow, 2) });
    view.pointerDown({ kind: "colHeader", col: 5 }, { shiftKey: true });
    view.pointerUp({ kind: "colHeader", col: 5 });
    expect(range()).toEqual({ start: cell(0, 2), end: cell(lastRow, 5) });
  });

  it("dragging across column headers extends the column selection", () => {
    const { view, range, model } = setup();
    const lastRow = model.dimensions().rowCount - 1;
    view.pointerDown({ kind: "colHeader", col: 1 });
    view.pointerMove({ kind: "colHeader", col: 3 });
    expect(range()).toEqual({ start: cell(0, 1), end: cell(lastRow, 3) });
  });

  it("row header selects the whole row; shift+header extends rows", () => {
    const { view, range, model } = setup();
    const lastCol = model.dimensions().colCount - 1;
    view.pointerDown({ kind: "rowHeader", row: 4 });
    view.pointerUp({ kind: "rowHeader", row: 4 });
    expect(range()).toEqual({ start: cell(4, 0), end: cell(4, lastCol) });
    view.pointerDown({ kind: "rowHeader", row: 1 }, { shiftKey: true });
    expect(range()).toEqual({ start: cell(1, 0), end: cell(4, lastCol) });
  });

  it("corner selects everything", () => {
    const { view, range, model } = setup();
    const { rowCount, colCount } = model.dimensions();
    view.pointerDown({ kind: "corner" });
    expect(range()).toEqual({ start: cell(0, 0), end: cell(rowCount - 1, colCount - 1) });
  });

  it("right-click outside the selection selects the cell; inside keeps the range", () => {
    const { view, range } = setup();
    view.pointerDown(cell(1, 1));
    view.pointerMove(cell(3, 3));
    view.pointerUp(cell(3, 3));
    view.contextMenu(cell(2, 2));
    expect(range()).toEqual({ start: cell(1, 1), end: cell(3, 3) });
    view.contextMenu(cell(7, 7));
    expect(range()).toEqual({ start: cell(7, 7), end: cell(7, 7) });
  });

  it("right-click on a header inside a selected column keeps it, else selects the column", () => {
    const { view, range, model } = setup();
    const lastRow = model.dimensions().rowCount - 1;
    view.pointerDown({ kind: "colHeader", col: 1 });
    view.pointerMove({ kind: "colHeader", col: 2 });
    view.pointerUp({ kind: "colHeader", col: 2 });
    view.contextMenu({ kind: "colHeader", col: 2 });
    expect(range()).toEqual({ start: cell(0, 1), end: cell(lastRow, 2) });
    view.contextMenu({ kind: "colHeader", col: 6 });
    expect(range()).toEqual({ start: cell(0, 6), end: cell(lastRow, 6) });
  });

  it("the selection stays on the same cells when a collaborator inserts a row above", () => {
    const { view, doc, sheetId, model, range, store } = setup();
    view.pointerDown(cell(2, 1));
    view.pointerMove(cell(3, 2));
    view.pointerUp(cell(3, 2));
    const before = store.getState().grid.selection;
    const rowId = model.rowIdAt(2);

    doc.transact(() => getRowOrderArray(doc, sheetId).insert(0, [newId()]), Symbol("remote"));

    expect(store.getState().grid.selection).toEqual(before);
    expect(range()).toEqual({ start: cell(3, 1), end: cell(4, 2) });
    expect(model.rowIdAt(3)).toBe(rowId);
  });

  it("a shift+click after a collaborator's insert extends from the same anchor cell", () => {
    const { view, doc, sheetId, sel } = setup();
    view.pointerDown(cell(2, 2));
    view.pointerUp(cell(2, 2));
    doc.transact(() => getRowOrderArray(doc, sheetId).insert(0, [newId()]));
    view.pointerDown(cell(6, 4), { shiftKey: true });
    expect(sel()!.anchor).toEqual(cell(3, 2));
    expect(sel()!.range).toEqual({ start: cell(3, 2), end: cell(6, 4) });
  });

  it("resets when the interaction is disposed", () => {
    const { view, store, interaction } = setup();
    view.pointerDown(cell(1, 1));
    interaction.dispose();
    expect(store.getState().grid).toEqual({
      sheetId: null,
      selection: null,
      editing: null,
      restore: null,
    });
  });
});
