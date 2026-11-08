import type { CellRange, GridDimensions } from "../port";

/** What a menu item (or a shortcut) does; indices are visual and inclusive where ranged. */
export type MenuAction =
  | { type: "insertRows"; at: number; count: number }
  | { type: "insertCols"; at: number; count: number }
  | { type: "deleteRows"; from: number; to: number }
  | { type: "deleteCols"; from: number; to: number }
  | { type: "clear"; range: CellRange };

export type MenuItemId =
  | "insert-rows-above"
  | "insert-rows-below"
  | "insert-cols-left"
  | "insert-cols-right"
  | "delete-rows"
  | "delete-cols"
  | "clear";

export interface MenuItem {
  id: MenuItemId;
  /** `data-testid` of the rendered item. */
  testId: string;
  label: string;
  disabled: boolean;
  action: MenuAction;
}

export type MenuDims = Pick<GridDimensions, "rowCount" | "colCount" | "colLabel">;

/** `rows`/`cols`: whole rows/columns are selected; `all`: the whole sheet; `cells`: anything else. */
export type SelectionKind = "rows" | "cols" | "all" | "cells";

export function selectionKind(range: CellRange, dims: MenuDims): SelectionKind {
  const wholeRows = range.start.col === 0 && range.end.col === dims.colCount - 1;
  const wholeCols = range.start.row === 0 && range.end.row === dims.rowCount - 1;
  if (wholeRows && wholeCols) return "all";
  if (wholeRows) return "rows";
  if (wholeCols) return "cols";
  return "cells";
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const span = (a: string, b: string, one: string, many: string) =>
  a === b ? `${one} ${a}` : `${many} ${a}–${b}`;

/**
 * The items for a selection, in menu order. Whole-row selections show only row items, whole-
 * column selections only column items, anything else both. Viewers get every item disabled;
 * deleting every row (or column) is disabled for everyone.
 */
export function buildMenu(range: CellRange, dims: MenuDims, readOnly: boolean): MenuItem[] {
  const kind = selectionKind(range, dims);
  const { start, end } = range;
  const nRows = end.row - start.row + 1;
  const nCols = end.col - start.col + 1;

  const rowItems: MenuItem[] = [
    {
      id: "insert-rows-above",
      testId: "menu-insert-rows-above",
      label: `Insert ${plural(nRows, "row")} above`,
      disabled: readOnly,
      action: { type: "insertRows", at: start.row, count: nRows },
    },
    {
      id: "insert-rows-below",
      testId: "menu-insert-rows-below",
      label: `Insert ${plural(nRows, "row")} below`,
      disabled: readOnly,
      action: { type: "insertRows", at: end.row + 1, count: nRows },
    },
  ];
  const colItems: MenuItem[] = [
    {
      id: "insert-cols-left",
      testId: "menu-insert-cols-left",
      label: `Insert ${plural(nCols, "column")} left`,
      disabled: readOnly,
      action: { type: "insertCols", at: start.col, count: nCols },
    },
    {
      id: "insert-cols-right",
      testId: "menu-insert-cols-right",
      label: `Insert ${plural(nCols, "column")} right`,
      disabled: readOnly,
      action: { type: "insertCols", at: end.col + 1, count: nCols },
    },
  ];
  const deleteRows: MenuItem = {
    id: "delete-rows",
    testId: "menu-delete-rows",
    label: `Delete ${span(String(start.row + 1), String(end.row + 1), "row", "rows")}`,
    disabled: readOnly || nRows >= dims.rowCount,
    action: { type: "deleteRows", from: start.row, to: end.row },
  };
  const deleteCols: MenuItem = {
    id: "delete-cols",
    testId: "menu-delete-cols",
    label: `Delete ${span(dims.colLabel(start.col), dims.colLabel(end.col), "column", "columns")}`,
    disabled: readOnly || nCols >= dims.colCount,
    action: { type: "deleteCols", from: start.col, to: end.col },
  };
  const clear: MenuItem = {
    id: "clear",
    testId: "menu-clear",
    label: "Clear contents",
    disabled: readOnly,
    action: { type: "clear", range },
  };

  switch (kind) {
    case "rows":
      return [...rowItems, deleteRows, clear];
    case "cols":
      return [...colItems, deleteCols, clear];
    default:
      return [...rowItems, ...colItems, deleteRows, deleteCols, clear];
  }
}

/**
 * Ctrl+Alt+= (insert) / Ctrl+Alt+- (delete). Insert goes before the selection: columns for whole
 * columns, otherwise rows (as many as the selection spans). Delete only acts on whole rows or
 * whole columns, since a cell range is ambiguous between the two. Null means "do nothing"
 * (viewer, ambiguous delete, or the delete would remove everything).
 */
export function structureShortcut(
  op: "insert" | "delete",
  range: CellRange,
  dims: MenuDims,
  readOnly: boolean,
): MenuAction | null {
  if (readOnly) return null;
  const kind = selectionKind(range, dims);
  const { start, end } = range;
  if (op === "insert") {
    return kind === "cols"
      ? { type: "insertCols", at: start.col, count: end.col - start.col + 1 }
      : { type: "insertRows", at: start.row, count: end.row - start.row + 1 };
  }
  if (kind === "rows" && end.row - start.row + 1 < dims.rowCount) {
    return { type: "deleteRows", from: start.row, to: end.row };
  }
  if (kind === "cols" && end.col - start.col + 1 < dims.colCount) {
    return { type: "deleteCols", from: start.col, to: end.col };
  }
  return null;
}
