// Pure geometry and planning for the fill handle: which cells a drag would fill, and
// which series value / source cell each target takes.

import {
  isHeaderHit,
  normalizeRange,
  type CellCoord,
  type CellRange,
  type GridTarget,
} from "../port";
import { fillSeries, type FillCell, type FillResult } from "./fill-series";

export type FillAxisDirection = "down" | "up" | "right" | "left";

export interface FillExtent {
  direction: FillAxisDirection;
  /** Number of rows (vertical) or columns (horizontal) added beyond the source. */
  count: number;
  /** Just the cells to fill. */
  target: CellRange;
  /** Source plus target: what the preview outlines and what gets selected afterwards. */
  union: CellRange;
}

export interface FillDims {
  rowCount: number;
  colCount: number;
}

/** Where a hit lands for fill purposes; headers count as "just outside" the grid on that axis. */
export function fillPointer(hit: GridTarget | null): CellCoord | null {
  if (hit === null) return null;
  if (!isHeaderHit(hit)) return hit;
  if (hit.kind === "colHeader") return { row: -1, col: hit.col };
  if (hit.kind === "rowHeader") return { row: hit.row, col: -1 };
  return null;
}

/**
 * The fill implied by dragging from `source` to `pointer`: along ONE axis, whichever the
 * pointer is further from the selection (rows win ties). Inside the selection there is
 * nothing to fill (null). The count is clamped to the sheet.
 */
export function fillExtent(
  source: CellRange,
  pointer: CellCoord,
  dims: FillDims,
): FillExtent | null {
  const rowsOut =
    pointer.row < source.start.row
      ? source.start.row - pointer.row
      : pointer.row > source.end.row
        ? pointer.row - source.end.row
        : 0;
  const colsOut =
    pointer.col < source.start.col
      ? source.start.col - pointer.col
      : pointer.col > source.end.col
        ? pointer.col - source.end.col
        : 0;
  if (rowsOut === 0 && colsOut === 0) return null;
  const { start, end } = source;
  if (rowsOut >= colsOut) {
    if (pointer.row > end.row) {
      const last = Math.min(pointer.row, dims.rowCount - 1);
      if (last <= end.row) return null;
      const target = {
        start: { row: end.row + 1, col: start.col },
        end: { row: last, col: end.col },
      };
      return {
        direction: "down",
        count: last - end.row,
        target,
        union: { start, end: { row: last, col: end.col } },
      };
    }
    const first = Math.max(pointer.row, 0);
    if (first >= start.row) return null;
    return {
      direction: "up",
      count: start.row - first,
      target: { start: { row: first, col: start.col }, end: { row: start.row - 1, col: end.col } },
      union: { start: { row: first, col: start.col }, end },
    };
  }
  if (pointer.col > end.col) {
    const last = Math.min(pointer.col, dims.colCount - 1);
    if (last <= end.col) return null;
    return {
      direction: "right",
      count: last - end.col,
      target: { start: { row: start.row, col: end.col + 1 }, end: { row: end.row, col: last } },
      union: { start, end: { row: end.row, col: last } },
    };
  }
  const first = Math.max(pointer.col, 0);
  if (first >= start.col) return null;
  return {
    direction: "left",
    count: start.col - first,
    target: { start: { row: start.row, col: first }, end: { row: end.row, col: start.col - 1 } },
    union: { start: { row: start.row, col: first }, end },
  };
}

export interface FillWrite {
  row: number;
  col: number;
  /** The source cell whose format this target takes (sources repeat cyclically). */
  formatFrom: CellCoord;
  /** A formula result's `offset` runs down/right (vertical fills move rows, horizontal columns). */
  result: FillResult;
}

/**
 * One series per line (a column when filling vertically, a row when horizontally). Source
 * cells are read in sheet order; results are placed moving away from the source.
 */
export function planFill(
  source: CellRange,
  extent: FillExtent,
  cellAt: (c: CellCoord) => FillCell,
): FillWrite[] {
  const vertical = extent.direction === "down" || extent.direction === "up";
  const forward = extent.direction === "down" || extent.direction === "right";
  const { start, end } = normalizeRange(source.start, source.end);
  const lines = vertical ? end.col - start.col + 1 : end.row - start.row + 1;
  const n = vertical ? end.row - start.row + 1 : end.col - start.col + 1;
  const writes: FillWrite[] = [];
  for (let line = 0; line < lines; line++) {
    const at = (i: number): CellCoord =>
      vertical
        ? { row: start.row + i, col: start.col + line }
        : { row: start.row + line, col: start.col + i };
    const cells = Array.from({ length: n }, (_, i) => cellAt(at(i)));
    const results = fillSeries(cells, extent.count, forward ? "forward" : "backward");
    results.forEach((result, t) => {
      const p = forward ? n + t : -(t + 1);
      const target = at(p); // p is the target's index along the line, relative to the first source cell
      const donor = at(((p % n) + n) % n);
      writes.push({ row: target.row, col: target.col, formatFrom: donor, result });
    });
  }
  return writes;
}
