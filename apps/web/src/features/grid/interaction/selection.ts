import { normalizeRange, type CellCoord, type CellRange, type GridDimensions } from "../port";

/** One cell identified by stable ids, so it survives structure changes by collaborators. */
export interface CellId {
  rowId: string;
  colId: string;
}

export interface IdSelection {
  anchor: CellId;
  focus: CellId;
}

/** The same selection as visual indices, for the grid port. */
export interface IndexSelection {
  anchor: CellCoord;
  focus: CellCoord;
}

export interface ResolvedSelection extends IndexSelection {
  range: CellRange;
}

/** What selection needs from the view model (SheetViewModel satisfies this). */
export interface IdMapper {
  rowIdAt(i: number): string | undefined;
  colIdAt(j: number): string | undefined;
  rowIndexOf(id: string): number | undefined;
  colIndexOf(id: string): number | undefined;
  dimensions(): Pick<GridDimensions, "rowCount" | "colCount">;
}

/**
 * Resolves each axis independently. If one endpoint's row (or column) was deleted
 * by a collaborator, the selection collapses onto the surviving endpoint on that
 * axis; if both are gone, there is nothing sensible to select and it resolves to null.
 */
function resolveAxis(
  a: string,
  f: string,
  indexOf: (id: string) => number | undefined,
): [number, number] | null {
  const ai = indexOf(a);
  const fi = indexOf(f);
  if (ai === undefined && fi === undefined) return null;
  return [ai ?? fi!, fi ?? ai!];
}

export function resolveSelection(
  selection: IdSelection | null,
  mapper: IdMapper,
): ResolvedSelection | null {
  if (!selection) return null;
  const rows = resolveAxis(selection.anchor.rowId, selection.focus.rowId, (id) =>
    mapper.rowIndexOf(id),
  );
  const cols = resolveAxis(selection.anchor.colId, selection.focus.colId, (id) =>
    mapper.colIndexOf(id),
  );
  if (!rows || !cols) return null;
  const anchor = { row: rows[0], col: cols[0] };
  const focus = { row: rows[1], col: cols[1] };
  return { anchor, focus, range: normalizeRange(anchor, focus) };
}

export function cellIdAt(c: CellCoord, mapper: IdMapper): CellId | null {
  const rowId = mapper.rowIdAt(c.row);
  const colId = mapper.colIdAt(c.col);
  return rowId === undefined || colId === undefined ? null : { rowId, colId };
}

/** Null if either endpoint lies outside the grid. */
export function toIdSelection(s: IndexSelection, mapper: IdMapper): IdSelection | null {
  const anchor = cellIdAt(s.anchor, mapper);
  const focus = cellIdAt(s.focus, mapper);
  return anchor && focus ? { anchor, focus } : null;
}

export function idSelectionsEqual(a: IdSelection | null, b: IdSelection | null): boolean {
  if (a === null || b === null) return a === b;
  const same = (x: CellId, y: CellId) => x.rowId === y.rowId && x.colId === y.colId;
  return same(a.anchor, b.anchor) && same(a.focus, b.focus);
}
