import type * as Y from "yjs";
import {
  cellKey,
  getFormatsMap,
  readColOrder,
  readRowOrder,
  shiftFormula,
  type CellData,
} from "@worksheet-clone/shared";
import { applyCellChanges, type CellChange } from "../../../crdt/mutations";
import { planFill, type FillExtent } from "../interaction/fill";
import type { FillCell } from "../interaction/fill-series";
import type { CellCoord, CellRange } from "../port";
import { parseCellInput } from "./parse-cell-input";
import { encodeCellInput } from "./set-cell-input";

/** The source cell as fill-series sees it, from what the user would see in the editor. */
export function fillCellFromInput(raw: string): FillCell {
  const parsed = parseCellInput(raw);
  if (parsed.kind === "clear") return { kind: "empty" };
  if (parsed.kind === "formula") return { kind: "formula", input: parsed.a1 };
  const v = parsed.value;
  if (typeof v === "number") return { kind: "number", value: v };
  if (typeof v === "boolean") return { kind: "bool", value: v };
  return { kind: "text", value: v };
}

/**
 * Fills `extent.target` from `source` as ONE transaction (one undo step): series values,
 * relatively shifted formulas (stored id-based through the typing path), and the source
 * cells' formats repeated cyclically. Returns false when nothing was written.
 */
export function fillRange(
  target: { doc: Y.Doc; readOnly: boolean },
  sheetId: string,
  model: {
    getRawInput(c: CellCoord): string;
    dimensions(): { rowCount: number; colCount: number };
  },
  source: CellRange,
  extent: FillExtent,
): boolean {
  const { doc } = target;
  const rows = readRowOrder(doc, sheetId);
  const cols = readColOrder(doc, sheetId);
  const formats = getFormatsMap(doc, sheetId);
  const dims = model.dimensions();
  const vertical = extent.direction === "down" || extent.direction === "up";
  const idsAt = (c: CellCoord) => {
    const rowId = rows[c.row];
    const colId = cols[c.col];
    return rowId === undefined || colId === undefined ? null : { rowId, colId };
  };

  const changes: CellChange[] = [];
  for (const write of planFill(source, extent, (c) => fillCellFromInput(model.getRawInput(c)))) {
    const ids = idsAt(write);
    const donor = idsAt(write.formatFrom);
    if (!ids || !donor) continue;
    const { result } = write;
    let data: CellData | undefined;
    if (result.kind === "formula") {
      const [dr, dc] = vertical ? [result.offset, 0] : [0, result.offset];
      data = encodeCellInput(doc, sheetId, shiftFormula(result.input, dr, dc, dims));
    } else if (result.kind !== "empty") {
      data = { v: result.value };
    }
    changes.push({ sheetId, ...ids, data, format: formats.get(cellKey(donor.rowId, donor.colId)) });
  }
  return applyCellChanges(doc, target.readOnly, changes);
}
