import type * as Y from "yjs";
import {
  cellKey,
  getCell,
  getFormatsMap,
  qualifyStoredFormula,
  readColOrder,
  readRowOrder,
} from "@worksheet-clone/shared";
import { applyCellChanges, type CellChange } from "../../../crdt/mutations";
import type { PasteEntry } from "../interaction/clipboard";
import type { CellCoord, CellRange } from "../port";
import { encodeCellInput } from "./set-cell-input";

type Target = { doc: Y.Doc; readOnly: boolean };

/**
 * Writes pasted entries through the typing path (so formulas are stored id-based and
 * `007` stays whatever typing it would be) as ONE transaction. Entries outside the grid
 * are skipped. Returns false when nothing was written.
 */
export function pasteEntries(target: Target, sheetId: string, entries: PasteEntry[]): boolean {
  const { doc } = target;
  const rows = readRowOrder(doc, sheetId);
  const cols = readColOrder(doc, sheetId);
  const changes: CellChange[] = [];
  for (const entry of entries) {
    const rowId = rows[entry.row];
    const colId = cols[entry.col];
    if (rowId === undefined || colId === undefined) continue;
    const change: CellChange = {
      sheetId,
      rowId,
      colId,
      data: encodeCellInput(doc, sheetId, entry.input),
    };
    if (entry.format !== undefined) change.format = entry.format ?? undefined;
    changes.push(change);
  }
  return applyCellChanges(doc, target.readOnly, changes);
}

export interface MoveResult {
  /** Where the moved cells ended up (clipped to the destination sheet). */
  range: CellRange;
  clipped: boolean;
}

/**
 * Cut-and-paste: copies the STORED cells (id-based formulas verbatim, so they keep
 * pointing at the same cells) and formats of `from` to `to`, then clears the source cells
 * that are not part of the destination. One transaction. Moving to another sheet
 * qualifies unqualified references with the source sheet so they keep their meaning.
 * Returns null when nothing moved.
 */
export function moveCells(
  target: Target,
  from: { sheetId: string; range: CellRange },
  to: { sheetId: string; anchor: CellCoord },
): MoveResult | null {
  const { doc } = target;
  const srcRows = readRowOrder(doc, from.sheetId);
  const srcCols = readColOrder(doc, from.sheetId);
  const dstRows = readRowOrder(doc, to.sheetId);
  const dstCols = readColOrder(doc, to.sheetId);
  const sameSheet = from.sheetId === to.sheetId;
  const srcFormats = getFormatsMap(doc, from.sheetId);

  const changes: CellChange[] = [];
  const written = new Set<string>();
  let clipped = false;
  let last: CellCoord | null = null;
  const moved: { rowId: string; colId: string }[] = [];

  for (let r = from.range.start.row; r <= from.range.end.row; r++) {
    for (let c = from.range.start.col; c <= from.range.end.col; c++) {
      const srcRowId = srcRows[r];
      const srcColId = srcCols[c];
      if (srcRowId === undefined || srcColId === undefined) continue;
      const row = to.anchor.row + (r - from.range.start.row);
      const col = to.anchor.col + (c - from.range.start.col);
      const rowId = dstRows[row];
      const colId = dstCols[col];
      if (rowId === undefined || colId === undefined) {
        clipped = true;
        continue;
      }
      const data = getCell(doc, from.sheetId, srcRowId, srcColId);
      const format = srcFormats.get(cellKey(srcRowId, srcColId));
      changes.push({
        sheetId: to.sheetId,
        rowId,
        colId,
        data:
          data?.f !== undefined && !sameSheet
            ? { f: qualifyStoredFormula(data.f, from.sheetId) }
            : data,
        format,
      });
      written.add(`${to.sheetId}:${cellKey(rowId, colId)}`);
      moved.push({ rowId: srcRowId, colId: srcColId });
      last = { row, col };
    }
  }
  if (!last) return null;
  for (const { rowId, colId } of moved) {
    if (written.has(`${from.sheetId}:${cellKey(rowId, colId)}`)) continue;
    changes.push({
      sheetId: from.sheetId,
      rowId,
      colId,
      data: undefined,
      format: undefined,
    });
  }
  if (!applyCellChanges(doc, target.readOnly, changes)) return null;
  return { range: { start: to.anchor, end: last }, clipped };
}
