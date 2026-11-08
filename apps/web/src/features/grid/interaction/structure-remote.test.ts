import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  deleteCols,
  deleteRows,
  insertRows,
  readColOrder,
  readRowOrder,
} from "@worksheet-clone/shared";
import { captureUndoContext, createWorkbookUndo } from "../../../crdt/undo";
import { edit, newDoc } from "../../../test-utils/workbook";
import { setCellInput } from "../commands/set-cell-input";
import { gridActions } from "../gridSlice";
import { mountInteraction } from "./test-harness";
import { repairSelection } from "./selection";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** The local client plus a collaborator whose edits arrive as remote transactions. */
function setup(readOnly = false) {
  const { doc: mine, sheetId } = newDoc();
  const theirs = new Y.Doc();
  Y.applyUpdate(theirs, Y.encodeStateAsUpdate(mine));
  const m = mountInteraction({ doc: mine, sheetId, readOnly });
  cleanups.push(() => m.dispose());
  const rows = readRowOrder(mine, sheetId);
  const cols = readColOrder(mine, sheetId);
  /** Runs `fn` on the collaborator's doc and delivers the result to us. */
  const remote = (fn: () => void) => {
    theirs.transact(fn, "collaborator");
    Y.applyUpdate(mine, Y.encodeStateAsUpdate(theirs, Y.encodeStateVector(mine)), "remote");
  };
  const click = (row: number, col: number) => {
    m.view.pointerDown({ row, col });
    m.view.pointerUp({ row, col });
  };
  return {
    ...m,
    rows,
    cols,
    theirs,
    remote,
    click,
    grid: () => m.store.getState().grid,
    toasts: () => m.store.getState().toasts.items.map((t) => t.message),
  };
}

describe("selection when a collaborator changes rows/columns", () => {
  it("deleting the row of your anchor moves the selection to the row now at that index", () => {
    const t = setup();
    t.click(5, 2);
    t.remote(() => deleteRows(t.theirs, t.sheetId, [t.rows[5]!]));
    expect(t.grid().selection).toEqual({
      anchor: { rowId: t.rows[6], colId: t.cols[2] },
      focus: { rowId: t.rows[6], colId: t.cols[2] },
    });
    // The id written back is valid, so later actions (and the view) agree.
    expect(t.model.rowIndexOf(t.grid().selection!.anchor.rowId)).toBe(5);
  });

  it("deleting both selected rows, or the last rows, clamps to a surviving row", () => {
    const t = setup();
    t.click(3, 0);
    t.view.pointerDown({ row: 3, col: 0 });
    t.view.pointerMove({ row: 4, col: 1 });
    t.view.pointerUp({ row: 4, col: 1 });
    t.remote(() => deleteRows(t.theirs, t.sheetId, [t.rows[3]!, t.rows[4]!]));
    const sel = t.grid().selection!;
    expect(t.model.rowIndexOf(sel.anchor.rowId)).toBe(3);
    expect(t.model.rowIndexOf(sel.focus.rowId)).toBe(3);
    expect(sel.anchor.colId).toBe(t.cols[0]);
    expect(sel.focus.colId).toBe(t.cols[1]);

    t.click(97, 0);
    const lastRows = readRowOrder(t.doc, t.sheetId).slice(-3);
    t.remote(() => deleteRows(t.theirs, t.sheetId, lastRows));
    expect(t.model.rowIndexOf(t.grid().selection!.anchor.rowId)).toBe(
      t.model.dimensions().rowCount - 1,
    );
  });

  it("deleting a selected column moves a whole-column selection onto the surviving column", () => {
    const t = setup();
    t.view.pointerDown({ kind: "colHeader", col: 1 });
    t.view.pointerMove({ kind: "colHeader", col: 2 });
    t.view.pointerUp({ kind: "colHeader", col: 2 });
    t.remote(() => deleteCols(t.theirs, t.sheetId, [t.cols[2]!]));
    const sel = t.grid().selection!;
    // The focus column (C) is gone: it now collapses onto the column that took its place (D).
    expect(t.model.colIndexOf(sel.anchor.colId)).toBe(1);
    expect(t.model.colIndexOf(sel.focus.colId)).toBe(2);
    expect(sel.anchor.rowId).toBe(t.rows[0]);
  });

  it("a remote insert above leaves the selection on the same cells, one row lower", () => {
    const t = setup();
    edit(t.doc, t.sheetId, 5, 2, { v: "mine" });
    t.click(5, 2);
    const before = t.grid().selection;
    t.remote(() => insertRows(t.theirs, t.sheetId, 2, 1));
    expect(t.grid().selection).toEqual(before);
    const resolved = t.model.getRawInput({ row: 6, col: 2 });
    expect(resolved).toBe("mine");
    expect(t.model.rowIndexOf(before!.anchor.rowId)).toBe(6);
  });
});

describe("the open edit when a collaborator deletes its row or column", () => {
  it("cancels the edit with a toast naming the row", () => {
    const t = setup();
    t.click(4, 1);
    t.view.keyDown({ key: "x" });
    expect(t.grid().editing).not.toBeNull();
    t.remote(() => deleteRows(t.theirs, t.sheetId, [t.rows[4]!]));
    expect(t.grid().editing).toBeNull();
    expect(t.toasts()).toEqual(["The row you were editing was deleted"]);
    t.interaction.commitEdit("x", null); // a late commit from the editor is a no-op
    expect(t.model.getRawInput({ row: 4, col: 1 })).toBe("");
  });

  it("names the column when only the column is gone", () => {
    const t = setup();
    t.click(4, 1);
    t.view.keyDown({ key: "x" });
    t.remote(() => deleteCols(t.theirs, t.sheetId, [t.cols[1]!]));
    expect(t.grid().editing).toBeNull();
    expect(t.toasts()).toEqual(["The column you were editing was deleted"]);
  });

  it("keeps the edit attached to the same cell when rows are inserted above", () => {
    const t = setup();
    t.click(4, 1);
    t.view.keyDown({ key: "4" });
    t.view.keyDown({ key: "2" });
    t.remote(() => insertRows(t.theirs, t.sheetId, 0, 3));
    expect(t.grid().editing).toMatchObject({ rowId: t.rows[4], colId: t.cols[1] });
    expect(t.toasts()).toEqual([]);
    t.interaction.commitEdit("42", null);
    expect(t.model.getRawInput({ row: 7, col: 1 })).toBe("42");
    expect(t.model.getRawInput({ row: 4, col: 1 })).toBe("");
  });
});

describe("undo steps whose selection ids vanished", () => {
  it("the context carries index hints; repairSelection falls back to the same index, clamped", () => {
    const t = setup();
    const undo = createWorkbookUndo(t.doc, {
      isReadOnly: () => false,
      getContext: () => captureUndoContext(t.doc, t.store.getState().grid),
    });
    cleanups.push(() => undo.destroy());
    t.click(5, 2);
    setCellInput({ doc: t.doc, readOnly: false }, t.sheetId, { row: 5, col: 2 }, "7");
    t.remote(() => deleteRows(t.theirs, t.sheetId, [t.rows[5]!]));
    t.store.dispatch(gridActions.selectionChanged(null));

    const context = undo.undo()!.context!;
    expect(context.selection?.hint).toEqual({
      anchor: { row: 5, col: 2 },
      focus: { row: 5, col: 2 },
    });
    const repaired = repairSelection(context.selection!, t.model.orders());
    expect(repaired).toEqual({
      anchor: { rowId: t.rows[6], colId: t.cols[2] },
      focus: { rowId: t.rows[6], colId: t.cols[2] },
    });
    // Without a hint nothing can be placed.
    expect(
      repairSelection({ anchor: repaired!.anchor, focus: repaired!.focus }, t.model.orders()),
    ).toEqual(repaired);
    expect(
      repairSelection(
        { anchor: { rowId: "gone", colId: "gone" }, focus: { rowId: "gone", colId: "gone" } },
        t.model.orders(),
      ),
    ).toBeNull();
    // A hint past the end clamps to the last row/column.
    const clamped = repairSelection(
      {
        anchor: { rowId: "gone", colId: "gone" },
        focus: { rowId: "gone", colId: "gone" },
        hint: { anchor: { row: 500, col: 500 }, focus: { row: 500, col: 500 } },
      },
      t.model.orders(),
    );
    expect(clamped?.anchor).toEqual({
      rowId: readRowOrder(t.doc, t.sheetId).at(-1),
      colId: readColOrder(t.doc, t.sheetId).at(-1),
    });
  });
});
