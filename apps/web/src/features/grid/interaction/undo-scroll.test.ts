import { afterEach, describe, expect, it } from "vitest";
import { readColOrder, readRowOrder } from "@worksheet-clone/shared";
import { gridActions } from "../gridSlice";
import { mountInteraction } from "./test-harness";

const mounted: ReturnType<typeof mountInteraction>[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.dispose();
});

const CTRL_Z = { key: "z", code: "KeyZ", ctrlKey: true } as const;

/** `history.undo` restores `restore` (as useUndoRedo does) when called. */
function setup(restore: (ids: { rows: string[]; cols: string[] }) => void) {
  let ids = { rows: [] as string[], cols: [] as string[] };
  const t = mountInteraction({
    history: { undo: () => restore(ids), redo: () => undefined },
  });
  ids = { rows: readRowOrder(t.doc, t.sheetId), cols: readColOrder(t.doc, t.sheetId) };
  mounted.push(t);
  return { ...t, ids };
}

describe("undo/redo scrolling", () => {
  it("restoring a whole-column selection (B:C) does not jump to the last row", () => {
    const t = setup(({ rows, cols }) =>
      t.store.dispatch(
        gridActions.selectionChanged({
          anchor: { rowId: rows[0]!, colId: cols[1]! },
          focus: { rowId: rows[rows.length - 1]!, colId: cols[2]! },
        }),
      ),
    );
    t.view.pointerDown({ row: 0, col: 0 });
    t.view.pointerUp({ row: 0, col: 0 });
    expect(t.view.scrollOffset.y).toBe(0);
    t.view.keyDown(CTRL_Z);
    // Regression: the focus corner is row 100, so scrolling to it moved the viewport down.
    expect(t.view.scrollOffset.y).toBe(0);
    expect(t.view.getCellRect({ row: 0, col: 1 })).not.toBeNull();
  });

  it("scrolls the active cell (anchor) into view, minimally, when it is off screen", () => {
    const t = setup(({ rows, cols }) =>
      t.store.dispatch(
        gridActions.selectionChanged({
          anchor: { rowId: rows[70]!, colId: cols[1]! },
          focus: { rowId: rows[99]!, colId: cols[2]! },
        }),
      ),
    );
    t.view.keyDown(CTRL_Z);
    expect(t.view.getCellRect({ row: 70, col: 1 })).not.toBeNull();
    // Not the focus corner: that would put row 99 at the bottom of the viewport.
    expect(t.view.getCellRect({ row: 99, col: 1 })).toBeNull();
  });

  it("leaves the viewport alone when the anchor is already visible", () => {
    const t = setup(({ rows, cols }) =>
      t.store.dispatch(
        gridActions.selectionChanged({
          anchor: { rowId: rows[2]!, colId: cols[0]! },
          focus: { rowId: rows[3]!, colId: cols[0]! },
        }),
      ),
    );
    t.view.scrollTo(0, 24);
    t.view.keyDown(CTRL_Z);
    expect(t.view.scrollOffset.y).toBe(24);
  });
});
