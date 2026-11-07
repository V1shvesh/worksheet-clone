import * as Y from "yjs";
import {
  createEmptyWorkbook,
  encodeFormula,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  setCell,
  type CellValue,
} from "@worksheet-clone/shared";

// Test-only helpers. They write straight to the doc, bypassing crdt/mutations.

export function newDoc(): { doc: Y.Doc; sheetId: string } {
  const doc = new Y.Doc();
  createEmptyWorkbook(doc);
  return { doc, sheetId: readSheetOrder(doc)[0]! };
}

export type Input = { v: CellValue } | { f: string } | undefined;

/** Writes one cell without opening a transaction, so callers can group writes. */
export function put(doc: Y.Doc, sheetId: string, row: number, col: number, input: Input): void {
  const rows = readRowOrder(doc, sheetId);
  const cols = readColOrder(doc, sheetId);
  const data =
    input && "f" in input
      ? { f: encodeFormula(input.f, { rowId: (i) => rows[i]!, colId: (j) => cols[j]! }) }
      : input;
  setCell(doc, sheetId, rows[row]!, cols[col]!, data);
}

export function edit(doc: Y.Doc, sheetId: string, row: number, col: number, input: Input): void {
  doc.transact(() => put(doc, sheetId, row, col, input));
}
