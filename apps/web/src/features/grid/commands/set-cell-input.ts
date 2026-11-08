import type * as Y from "yjs";
import {
  createSheetNameIndex,
  encodeFormula,
  getSheetName,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  type CellData,
} from "@worksheet-clone/shared";
import { setCellContent } from "../../../crdt/mutations";
import type { CellCoord } from "../port";
import { parseCellInput } from "./parse-cell-input";

// Never a real id (real ones are 12 hex chars), so a reference to a cell
// outside the grid decodes to #REF! instead of pointing somewhere else.
const MISSING_ID = "outside-grid";

/**
 * What typing `raw` into a cell of `sheetId` stores: a value, an id-based formula, or
 * undefined (clear). Pure read of the doc; formulas pointing outside the grid become #REF!.
 */
export function encodeCellInput(doc: Y.Doc, sheetId: string, raw: string): CellData | undefined {
  const parsed = parseCellInput(raw);
  if (parsed.kind === "formula") {
    const rows = readRowOrder(doc, sheetId);
    const cols = readColOrder(doc, sheetId);
    return {
      f: encodeFormula(parsed.a1, {
        sheetId,
        sheetIdByName: createSheetNameIndex(
          readSheetOrder(doc).map((id) => ({ id, name: getSheetName(doc, id) ?? "" })),
        ),
        resolver: (id) => {
          const r = id === sheetId ? rows : readRowOrder(doc, id);
          const c = id === sheetId ? cols : readColOrder(doc, id);
          return { rowId: (i) => r[i] ?? MISSING_ID, colId: (j) => c[j] ?? MISSING_ID };
        },
      }),
    };
  }
  return parsed.kind === "value" ? { v: parsed.value } : undefined;
}

/** Applies what the user typed to one cell. Returns false if nothing was written. */
export function setCellInput(
  target: { doc: Y.Doc; readOnly: boolean },
  sheetId: string,
  coord: CellCoord,
  raw: string,
): boolean {
  const { doc, readOnly } = target;
  const rowId = readRowOrder(doc, sheetId)[coord.row];
  const colId = readColOrder(doc, sheetId)[coord.col];
  if (rowId === undefined || colId === undefined) return false;
  return setCellContent(doc, readOnly, sheetId, rowId, colId, encodeCellInput(doc, sheetId, raw));
}
