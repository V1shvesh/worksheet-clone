import type * as Y from "yjs";
import { clearCells } from "../../../crdt/mutations";
import type { CellRange } from "../port";

/** Clears the contents of every cell in the range (formats stay) as one transaction. */
export function clearRange(
  target: { doc: Y.Doc; readOnly: boolean },
  sheetId: string,
  range: CellRange,
  model: { rowIdAt(i: number): string | undefined; colIdAt(j: number): string | undefined },
): boolean {
  const cells: { rowId: string; colId: string }[] = [];
  for (let row = range.start.row; row <= range.end.row; row++) {
    const rowId = model.rowIdAt(row);
    if (rowId === undefined) continue;
    for (let col = range.start.col; col <= range.end.col; col++) {
      const colId = model.colIdAt(col);
      if (colId !== undefined) cells.push({ rowId, colId });
    }
  }
  if (cells.length === 0) return false;
  return clearCells(target.doc, target.readOnly, sheetId, cells);
}
