import { normalizeRange, type CellCoord, type CellRange, type GridDimensions } from "../port";

/** One cell identified by stable ids, so it survives structure changes by collaborators. */
export interface CellId {
  rowId: string;
  colId: string;
}

export interface IdSelection {
  anchor: CellId;
  focus: CellId;
  /**
   * Only on selections remembered by the undo stack: where the corners were when the action
   * happened, as visual indices. If an id has vanished by the time the step is undone, the
   * nearest surviving row/column at that index is used instead (see `repairSelection`).
   */
  hint?: IndexSelection;
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
  count: number,
  hint?: [number, number],
): [number, number] | null {
  const ai = indexOf(a);
  const fi = indexOf(f);
  if (ai === undefined && fi === undefined) {
    // Both ends are gone: with an undo hint, land on the same index (clamped); else nothing.
    if (!hint || count === 0) return null;
    const clamp = (i: number) => Math.min(Math.max(i, 0), count - 1);
    return [clamp(hint[0]), clamp(hint[1])];
  }
  return [ai ?? fi!, fi ?? ai!];
}

export function resolveSelection(
  selection: IdSelection | null,
  mapper: IdMapper,
): ResolvedSelection | null {
  if (!selection) return null;
  const { rowCount, colCount } = mapper.dimensions();
  const h = selection.hint;
  const rows = resolveAxis(
    selection.anchor.rowId,
    selection.focus.rowId,
    (id) => mapper.rowIndexOf(id),
    rowCount,
    h && [h.anchor.row, h.focus.row],
  );
  const cols = resolveAxis(
    selection.anchor.colId,
    selection.focus.colId,
    (id) => mapper.colIndexOf(id),
    colCount,
    h && [h.anchor.col, h.focus.col],
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

/** The row and column ids of one sheet in visual order. */
export interface OrderSnapshot {
  rowIds: readonly string[];
  colIds: readonly string[];
}

/** One id of a selection corner: itself if it still exists, else the survivor at its old index. */
function survivor(
  id: string,
  now: readonly string[],
  was: readonly string[] | undefined,
  hintIndex: number | undefined,
): string | undefined {
  if (now.includes(id)) return id;
  if (now.length === 0) return undefined;
  const last = now.length - 1;
  const old = was?.indexOf(id) ?? -1;
  if (was && old >= 0) {
    // The id that took its place: as many survivors precede it as did before the deletion, so
    // every row of a deleted run maps to the row right after the run.
    const alive = new Set(now);
    let index = 0;
    for (let i = 0; i < old; i++) if (alive.has(was[i]!)) index++;
    return now[Math.min(index, last)];
  }
  if (hintIndex === undefined) return undefined;
  return now[Math.min(Math.max(hintIndex, 0), last)];
}

/**
 * Makes every id of `selection` exist in `now`. A row/column that is gone is replaced by the
 * one that now sits at its old index (clamped to the last), where "old index" comes from
 * `prior` (the order before the change, for live collaborator edits) or else from the
 * selection's `hint` (the undo stack). If one corner of an axis cannot be placed it follows the
 * other; null when neither can. The result never carries a hint.
 */
export function repairSelection(
  selection: IdSelection,
  now: OrderSnapshot,
  prior?: OrderSnapshot,
): IdSelection | null {
  const { anchor, focus, hint } = selection;
  const rowA = survivor(anchor.rowId, now.rowIds, prior?.rowIds, hint?.anchor.row);
  const rowF = survivor(focus.rowId, now.rowIds, prior?.rowIds, hint?.focus.row);
  const colA = survivor(anchor.colId, now.colIds, prior?.colIds, hint?.anchor.col);
  const colF = survivor(focus.colId, now.colIds, prior?.colIds, hint?.focus.col);
  const rowAnchor = rowA ?? rowF;
  const rowFocus = rowF ?? rowA;
  const colAnchor = colA ?? colF;
  const colFocus = colF ?? colA;
  if (
    rowAnchor === undefined ||
    rowFocus === undefined ||
    colAnchor === undefined ||
    colFocus === undefined
  ) {
    return null;
  }
  return {
    anchor: { rowId: rowAnchor, colId: colAnchor },
    focus: { rowId: rowFocus, colId: colFocus },
  };
}

/** Attaches the undo hint (current indices of the corners) to a selection; unchanged if an id is unknown. */
export function withHint(selection: IdSelection, now: OrderSnapshot): IdSelection {
  const ar = now.rowIds.indexOf(selection.anchor.rowId);
  const fr = now.rowIds.indexOf(selection.focus.rowId);
  const ac = now.colIds.indexOf(selection.anchor.colId);
  const fc = now.colIds.indexOf(selection.focus.colId);
  if (ar < 0 || fr < 0 || ac < 0 || fc < 0) return selection;
  return {
    anchor: selection.anchor,
    focus: selection.focus,
    hint: { anchor: { row: ar, col: ac }, focus: { row: fr, col: fc } },
  };
}
