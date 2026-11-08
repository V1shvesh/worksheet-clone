import { describe, expect, it } from "vitest";
import { colIndexToLabel } from "@worksheet-clone/shared";
import type { CellRange } from "../port";
import { buildMenu, selectionKind, structureShortcut } from "./context-menu";

const dims = { rowCount: 10, colCount: 6, colLabel: colIndexToLabel };
const range = (r0: number, c0: number, r1 = r0, c1 = c0): CellRange => ({
  start: { row: r0, col: c0 },
  end: { row: r1, col: c1 },
});
const labels = (r: CellRange, readOnly = false) => buildMenu(r, dims, readOnly).map((i) => i.label);

describe("selectionKind", () => {
  it("tells whole rows, whole columns, everything and plain cells apart", () => {
    expect(selectionKind(range(2, 0, 4, 5), dims)).toBe("rows");
    expect(selectionKind(range(0, 1, 9, 2), dims)).toBe("cols");
    expect(selectionKind(range(0, 0, 9, 5), dims)).toBe("all");
    expect(selectionKind(range(2, 1, 4, 3), dims)).toBe("cells");
  });
});

describe("buildMenu", () => {
  it("labels follow the selection size", () => {
    expect(labels(range(1, 0, 3, 5))).toEqual([
      "Insert 3 rows above",
      "Insert 3 rows below",
      "Delete rows 2–4",
      "Clear contents",
    ]);
    expect(labels(range(0, 2, 9, 2))).toEqual([
      "Insert 1 column left",
      "Insert 1 column right",
      "Delete column C",
      "Clear contents",
    ]);
    expect(labels(range(0, 1, 9, 3))).toContain("Delete columns B–D");
    expect(labels(range(4, 2))).toEqual([
      "Insert 1 row above",
      "Insert 1 row below",
      "Insert 1 column left",
      "Insert 1 column right",
      "Delete row 5",
      "Delete column C",
      "Clear contents",
    ]);
  });

  it("insert positions are the selection edges", () => {
    const items = buildMenu(range(2, 1, 4, 3), dims, false);
    const action = (id: string) => items.find((i) => i.id === id)!.action;
    expect(action("insert-rows-above")).toEqual({ type: "insertRows", at: 2, count: 3 });
    expect(action("insert-rows-below")).toEqual({ type: "insertRows", at: 5, count: 3 });
    expect(action("insert-cols-left")).toEqual({ type: "insertCols", at: 1, count: 3 });
    expect(action("insert-cols-right")).toEqual({ type: "insertCols", at: 4, count: 3 });
    expect(action("delete-rows")).toEqual({ type: "deleteRows", from: 2, to: 4 });
    expect(action("delete-cols")).toEqual({ type: "deleteCols", from: 1, to: 3 });
  });

  it("disables everything for viewers", () => {
    expect(buildMenu(range(1, 1), dims, true).every((i) => i.disabled)).toBe(true);
    expect(buildMenu(range(1, 1), dims, false).some((i) => i.disabled)).toBe(false);
  });

  it("disables deleting every row or every column", () => {
    const all = buildMenu(range(0, 0, 9, 5), dims, false);
    expect(all.find((i) => i.id === "delete-rows")!.disabled).toBe(true);
    expect(all.find((i) => i.id === "delete-cols")!.disabled).toBe(true);
    const rows = buildMenu(range(0, 0, 8, 5), dims, false);
    expect(rows.find((i) => i.id === "delete-rows")!.disabled).toBe(false);
  });
});

describe("structureShortcut", () => {
  it("inserts columns for whole columns and rows otherwise", () => {
    expect(structureShortcut("insert", range(0, 2, 9, 3), dims, false)).toEqual({
      type: "insertCols",
      at: 2,
      count: 2,
    });
    expect(structureShortcut("insert", range(3, 0, 4, 5), dims, false)).toEqual({
      type: "insertRows",
      at: 3,
      count: 2,
    });
    expect(structureShortcut("insert", range(3, 3), dims, false)).toEqual({
      type: "insertRows",
      at: 3,
      count: 1,
    });
  });

  it("deletes only whole rows or columns, never everything, never for viewers", () => {
    expect(structureShortcut("delete", range(3, 0, 4, 5), dims, false)).toEqual({
      type: "deleteRows",
      from: 3,
      to: 4,
    });
    expect(structureShortcut("delete", range(0, 1, 9, 1), dims, false)).toEqual({
      type: "deleteCols",
      from: 1,
      to: 1,
    });
    expect(structureShortcut("delete", range(3, 3), dims, false)).toBeNull();
    expect(structureShortcut("delete", range(0, 0, 9, 5), dims, false)).toBeNull();
    expect(structureShortcut("delete", range(3, 0, 4, 5), dims, true)).toBeNull();
    expect(structureShortcut("insert", range(3, 3), dims, true)).toBeNull();
  });
});
