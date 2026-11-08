import type * as Y from "yjs";
import { cellKey, getFormatsMap, readColOrder, readRowOrder } from "@worksheet-clone/shared";
import { setFormat, type FormatPatch } from "../../../crdt/mutations";
import type { IdSelection } from "../interaction/selection";

export type FormatFlag = "b" | "i" | "u";

/** Every cell of the selection's rectangle, resolved through the sheet's current id order. */
export function selectionCells(
  doc: Y.Doc,
  sheetId: string,
  selection: IdSelection,
): { rowId: string; colId: string }[] {
  const rows = readRowOrder(doc, sheetId);
  const cols = readColOrder(doc, sheetId);
  const span = (ids: string[], a: string, b: string): string[] => {
    const i = ids.indexOf(a);
    const j = ids.indexOf(b);
    // One endpoint's row/column was deleted by a collaborator: use the survivor.
    if (i === -1 && j === -1) return [];
    const lo = Math.min(i === -1 ? j : i, j === -1 ? i : j);
    const hi = Math.max(i === -1 ? j : i, j === -1 ? i : j);
    return ids.slice(lo, hi + 1);
  };
  const rowIds = span(rows, selection.anchor.rowId, selection.focus.rowId);
  const colIds = span(cols, selection.anchor.colId, selection.focus.colId);
  return rowIds.flatMap((rowId) => colIds.map((colId) => ({ rowId, colId })));
}

export function activeCellFormat(doc: Y.Doc, sheetId: string, selection: IdSelection | null) {
  if (!selection) return undefined;
  const { rowId, colId } = selection.anchor;
  return getFormatsMap(doc, sheetId).get(cellKey(rowId, colId));
}

/** Applies a patch to the whole selection as one transaction. */
export function formatSelection(
  target: { doc: Y.Doc; readOnly: boolean },
  sheetId: string,
  selection: IdSelection,
  patch: FormatPatch,
): boolean {
  return setFormat(
    target.doc,
    target.readOnly,
    sheetId,
    selectionCells(target.doc, sheetId, selection),
    patch,
  );
}

/**
 * Bold/italic/underline toggle. The active cell (the selection anchor) decides, as in
 * Sheets: if it has the flag the whole selection loses it, otherwise the whole selection gets it.
 */
export function toggleFormat(
  target: { doc: Y.Doc; readOnly: boolean },
  sheetId: string,
  selection: IdSelection,
  flag: FormatFlag,
): boolean {
  const on = activeCellFormat(target.doc, sheetId, selection)?.[flag] === true;
  return formatSelection(target, sheetId, selection, { [flag]: !on });
}
