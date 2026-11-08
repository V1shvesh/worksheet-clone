import { colIndexToLabel } from "@worksheet-clone/shared";
import type { CellRange } from "../grid/port";

/**
 * A1 notation for a selection: `B2`, `B2:C5`, a whole column `A:A` / `A:C`, a whole
 * row `3:3` / `3:5` (a range spanning every row/column of the sheet), or the full sheet range.
 */
export function selectionLabel(
  range: CellRange,
  dims: { rowCount: number; colCount: number },
): string {
  const { start, end } = range;
  const allRows = start.row === 0 && end.row === dims.rowCount - 1;
  const allCols = start.col === 0 && end.col === dims.colCount - 1;
  const cell = (row: number, col: number) => `${colIndexToLabel(col)}${row + 1}`;
  if (allRows && allCols) return `${cell(0, 0)}:${cell(end.row, end.col)}`;
  if (allRows) return `${colIndexToLabel(start.col)}:${colIndexToLabel(end.col)}`;
  if (allCols) return `${start.row + 1}:${end.row + 1}`;
  if (start.row === end.row && start.col === end.col) return cell(start.row, start.col);
  return `${cell(start.row, start.col)}:${cell(end.row, end.col)}`;
}
