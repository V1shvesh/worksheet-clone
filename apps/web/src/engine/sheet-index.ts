import type * as Y from "yjs";
import { getSheet, readColOrder, readRowOrder, type IdLookup } from "@worksheet-clone/shared";

/**
 * Row/column id → index lookup for any sheet in the doc, or undefined when the
 * sheet doesn't exist (deleted: formulas pointing at it decode to #REF!).
 */
export function lookupSheetIndex(doc: Y.Doc, sheetId: string): IdLookup | undefined {
  if (!getSheet(doc, sheetId)) return undefined;
  const rows = new Map(readRowOrder(doc, sheetId).map((id, i) => [id, i]));
  const cols = new Map(readColOrder(doc, sheetId).map((id, i) => [id, i]));
  return { rowIndex: (id) => rows.get(id), colIndex: (id) => cols.get(id) };
}
