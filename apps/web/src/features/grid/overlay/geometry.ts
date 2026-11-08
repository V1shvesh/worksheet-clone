import type { CellCoord, CellRange, GridView, Rect } from "../port";

/** The part of `range` inside `visible`, or null if they don't overlap. */
export function intersectRanges(a: CellRange, b: CellRange): CellRange | null {
  const start: CellCoord = {
    row: Math.max(a.start.row, b.start.row),
    col: Math.max(a.start.col, b.start.col),
  };
  const end: CellCoord = {
    row: Math.min(a.end.row, b.end.row),
    col: Math.min(a.end.col, b.end.col),
  };
  return start.row <= end.row && start.col <= end.col ? { start, end } : null;
}

/**
 * Pixel rect of the visible part of a range, from `getCellRect` of its two corner cells only.
 * A range that is partly scrolled away is clipped to the visible cell range first, so its
 * corners are always rendered cells.
 */
export function visibleRangeRect(view: GridView, range: CellRange): Rect | null {
  const clipped = intersectRanges(range, view.getVisibleRange());
  if (!clipped) return null;
  const first = view.getCellRect(clipped.start);
  const last = view.getCellRect(clipped.end);
  if (!first || !last) return null;
  const x = Math.min(first.x, last.x);
  const y = Math.min(first.y, last.y);
  return {
    x,
    y,
    width: Math.max(first.x + first.width, last.x + last.width) - x,
    height: Math.max(first.y + first.height, last.y + last.height) - y,
  };
}
