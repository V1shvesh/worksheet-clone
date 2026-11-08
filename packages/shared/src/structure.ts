import type * as Y from "yjs";
import {
  getCellsMap,
  getColOrderArray,
  getColWidthsMap,
  getFormatsMap,
  getRowHeightsMap,
  getRowOrderArray,
  newId,
  readColOrder,
  readRowOrder,
} from "./doc-schema.js";

// Row/column structure operations (M7). Like the other doc helpers, writers
// here never open their own transaction: the caller wraps one user action in
// one doc.transact.
//
// Orphans: a concurrent writer can put a cell, format or size entry under a
// row/column id that another client deleted in the meantime. The entry stays
// in its map but its id is in no order array, so it is invisible. Readers must
// ignore entries whose ids are not in the (deduped) order; nothing sweeps
// them.

export const MAX_ROW_COUNT = 10_000;
export const MAX_COL_COUNT = 500;

type Axis = "row" | "col";

function rawOrder(doc: Y.Doc, sheetId: string, axis: Axis): Y.Array<string> {
  return axis === "row" ? getRowOrderArray(doc, sheetId) : getColOrderArray(doc, sheetId);
}

function visibleOrder(doc: Y.Doc, sheetId: string, axis: Axis): string[] {
  return axis === "row" ? readRowOrder(doc, sheetId) : readColOrder(doc, sheetId);
}

function insertIds(
  doc: Y.Doc,
  sheetId: string,
  axis: Axis,
  at: number,
  count: number,
  cap: number,
): string[] | null {
  const visible = visibleOrder(doc, sheetId, axis);
  const n = Math.trunc(count);
  if (!Number.isFinite(n) || n < 1 || visible.length + n > cap) return null;
  const target = Math.max(0, Math.min(Math.trunc(at), visible.length));
  const order = rawOrder(doc, sheetId, axis);
  // `at` counts deduped ids; the raw array may hold duplicates. Insert just
  // before the first raw occurrence of the id that should follow, so readers
  // see the new ids exactly at index `target`.
  const follower = visible[target];
  const position = follower === undefined ? order.length : order.toArray().indexOf(follower);
  const ids = Array.from({ length: n }, () => newId());
  order.insert(position, ids);
  return ids;
}

/** Inserts `count` new rows so the first sits at visual index `at`; null (nothing written) past MAX_ROW_COUNT. */
export function insertRows(
  doc: Y.Doc,
  sheetId: string,
  at: number,
  count: number,
): string[] | null {
  return insertIds(doc, sheetId, "row", at, count, MAX_ROW_COUNT);
}

/** Inserts `count` new columns so the first sits at visual index `at`; null (nothing written) past MAX_COL_COUNT. */
export function insertCols(
  doc: Y.Doc,
  sheetId: string,
  at: number,
  count: number,
): string[] | null {
  return insertIds(doc, sheetId, "col", at, count, MAX_COL_COUNT);
}

function removeIds(order: Y.Array<string>, ids: ReadonlySet<string>): void {
  for (let i = order.length - 1; i >= 0; i--) {
    if (ids.has(order.get(i) as string)) order.delete(i, 1);
  }
}

function keyHasId(key: string, axis: Axis, ids: ReadonlySet<string>): boolean {
  const colon = key.indexOf(":");
  if (colon === -1) return false;
  return ids.has(axis === "row" ? key.slice(0, colon) : key.slice(colon + 1));
}

function deleteEntries<T>(map: Y.Map<T>, axis: Axis, ids: ReadonlySet<string>): void {
  for (const key of [...map.keys()]) {
    if (keyHasId(key, axis, ids)) map.delete(key);
  }
}

function deleteIds(doc: Y.Doc, sheetId: string, axis: Axis, idList: string[]): boolean {
  const ids = new Set(idList);
  const visible = visibleOrder(doc, sheetId, axis);
  const present = visible.filter((id) => ids.has(id));
  if (present.length === 0) return false;
  if (visible.length - present.length < 1) return false;
  removeIds(rawOrder(doc, sheetId, axis), ids);
  deleteEntries(getCellsMap(doc, sheetId), axis, ids);
  deleteEntries(getFormatsMap(doc, sheetId), axis, ids);
  const sizes = axis === "row" ? getRowHeightsMap(doc, sheetId) : getColWidthsMap(doc, sheetId);
  for (const id of ids) sizes.delete(id);
  return true;
}

/**
 * Removes the rows (every occurrence in the order array) and their cells,
 * formats and heights. Returns false and writes nothing when none of the ids
 * is a row of the sheet or when it would leave the sheet with no rows.
 */
export function deleteRows(doc: Y.Doc, sheetId: string, rowIds: string[]): boolean {
  return deleteIds(doc, sheetId, "row", rowIds);
}

/** Column counterpart of {@link deleteRows}. */
export function deleteCols(doc: Y.Doc, sheetId: string, colIds: string[]): boolean {
  return deleteIds(doc, sheetId, "col", colIds);
}
