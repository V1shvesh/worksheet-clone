import type * as Y from "yjs";
import { encodeFormula, readColOrder, readRowOrder, type CellData } from "@worksheet-clone/shared";
import { setCellContent } from "../../../crdt/mutations";
import type { CellCoord } from "../port";
import { parseCellInput } from "./parse-cell-input";

// Never a real id (real ones are 12 hex chars), so a reference to a cell
// outside the grid decodes to #REF! instead of pointing somewhere else.
const MISSING_ID = "outside-grid";

/** Applies what the user typed to one cell. Returns false if nothing was written. */
export function setCellInput(
  target: { doc: Y.Doc; readOnly: boolean },
  sheetId: string,
  coord: CellCoord,
  raw: string,
): boolean {
  const { doc, readOnly } = target;
  const rows = readRowOrder(doc, sheetId);
  const cols = readColOrder(doc, sheetId);
  const rowId = rows[coord.row];
  const colId = cols[coord.col];
  if (rowId === undefined || colId === undefined) return false;

  const parsed = parseCellInput(raw);
  let data: CellData | undefined;
  if (parsed.kind === "formula") {
    data = {
      f: encodeFormula(parsed.a1, {
        rowId: (i) => rows[i] ?? MISSING_ID,
        colId: (j) => cols[j] ?? MISSING_ID,
      }),
    };
  } else if (parsed.kind === "value") {
    data = { v: parsed.value };
  }
  return setCellContent(doc, readOnly, sheetId, rowId, colId, data);
}
