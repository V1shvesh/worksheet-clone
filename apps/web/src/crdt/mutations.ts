import { useMemo } from "react";
import type * as Y from "yjs";
import {
  addSheet as addSheetToDoc,
  cellKey,
  deleteCols as deleteColsInDoc,
  deleteRows as deleteRowsInDoc,
  deleteSheet as deleteSheetFromDoc,
  getColWidthsMap,
  getFormatsMap,
  getRowHeightsMap,
  getSheetName,
  hasOtherVisibleSheet,
  insertCols as insertColsInDoc,
  insertRows as insertRowsInDoc,
  isSheetHidden,
  isSheetNameTaken,
  moveSheet as moveSheetInDoc,
  nextSheetName,
  setCell,
  setSheetHidden as setSheetHiddenInDoc,
  setSheetName,
  sheetNameSchema,
  type CellData,
  type CellFormat,
} from "@worksheet-clone/shared";
import { LOCAL_ORIGIN } from "./origin";
import { useWorkbookDoc } from "./WorkbookDoc";

// The only code allowed to write to the Y.Doc. Each user action is exactly
// one transaction tagged LOCAL_ORIGIN, so it syncs atomically and undoes as a
// single step.
//
// Writes are refused while read-only: the server would drop them, but the
// local replica would keep them and silently diverge (see failure-log.md).
function transact(doc: Y.Doc, readOnly: boolean, change: () => void): boolean {
  if (readOnly) {
    return false;
  }
  doc.transact(change, LOCAL_ORIGIN);
  return true;
}

export type RenameResult = { ok: true } | { ok: false; error: string };

/**
 * Renames a sheet. Names are trimmed, validated and unique ignoring case
 * (hidden sheets count); an unchanged name succeeds without writing.
 */
export function renameSheet(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  name: string,
): RenameResult {
  if (readOnly) return { ok: false, error: "You can't edit this workbook" };
  const parsed = sheetNameSchema.safeParse(name);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid sheet name" };
  }
  const trimmed = parsed.data;
  if (getSheetName(doc, sheetId) === undefined) return { ok: false, error: "Sheet not found" };
  if (getSheetName(doc, sheetId) === trimmed) return { ok: true };
  if (isSheetNameTaken(doc, trimmed, sheetId)) {
    return { ok: false, error: `A sheet named "${trimmed}" already exists` };
  }
  doc.transact(() => setSheetName(doc, sheetId, trimmed), LOCAL_ORIGIN);
  return { ok: true };
}

/** Adds a sheet with the next free default name after `afterSheetId`; returns its id. */
export function addSheet(doc: Y.Doc, readOnly: boolean, afterSheetId?: string): string | null {
  let id: string | null = null;
  const done = transact(doc, readOnly, () => {
    id = addSheetToDoc(doc, nextSheetName(doc), afterSheetId === undefined ? {} : { afterSheetId });
  });
  return done ? id : null;
}

/** Hides or unhides; hiding the last visible sheet is refused. */
export function setSheetHidden(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  hidden: boolean,
): boolean {
  if (getSheetName(doc, sheetId) === undefined) return false;
  if (hidden && !isSheetHidden(doc, sheetId) && !hasOtherVisibleSheet(doc, sheetId)) return false;
  return transact(doc, readOnly, () => setSheetHiddenInDoc(doc, sheetId, hidden));
}

/** Deletes a sheet; deleting the last visible sheet is refused. */
export function deleteSheet(doc: Y.Doc, readOnly: boolean, sheetId: string): boolean {
  if (getSheetName(doc, sheetId) === undefined) return false;
  if (!isSheetHidden(doc, sheetId) && !hasOtherVisibleSheet(doc, sheetId)) return false;
  return transact(doc, readOnly, () => deleteSheetFromDoc(doc, sheetId));
}

/** Moves a sheet to `toIndex` in sheet-order terms (hidden sheets included). */
export function moveSheet(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  toIndex: number,
): boolean {
  if (getSheetName(doc, sheetId) === undefined) return false;
  return transact(doc, readOnly, () => moveSheetInDoc(doc, sheetId, toIndex));
}

/** Sets or clears (`undefined`) one cell in a single transaction. */
export function setCellContent(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  rowId: string,
  colId: string,
  data: CellData | undefined,
): boolean {
  return transact(doc, readOnly, () => setCell(doc, sheetId, rowId, colId, data));
}

/** Deletes the content of every given cell (formats stay) in a single transaction. */
export function clearCells(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  cells: readonly { rowId: string; colId: string }[],
): boolean {
  return transact(doc, readOnly, () => {
    for (const { rowId, colId } of cells) setCell(doc, sheetId, rowId, colId, undefined);
  });
}

/**
 * Format changes for a set of cells: `b`/`i`/`u` true sets the flag and false removes it
 * (only `true` is ever stored); `bg` is a color, or null to remove it.
 */
export interface FormatPatch {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  bg?: string | null;
}

function patched(current: CellFormat | undefined, patch: FormatPatch): CellFormat | undefined {
  const next: CellFormat = { ...current };
  for (const flag of ["b", "i", "u"] as const) {
    if (patch[flag] === true) next[flag] = true;
    else if (patch[flag] === false) delete next[flag];
  }
  if (typeof patch.bg === "string") next.bg = patch.bg;
  else if (patch.bg === null) delete next.bg;
  return Object.keys(next).length === 0 ? undefined : next;
}

/**
 * Applies a format patch to every cell in a single transaction. Formats on empty
 * cells are kept; a cell whose format ends up empty loses its entry.
 */
export function setFormat(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  cells: readonly { rowId: string; colId: string }[],
  patch: FormatPatch,
): boolean {
  if (cells.length === 0 || getSheetName(doc, sheetId) === undefined) return false;
  return transact(doc, readOnly, () => {
    const formats = getFormatsMap(doc, sheetId);
    for (const { rowId, colId } of cells) {
      const key = cellKey(rowId, colId);
      const next = patched(formats.get(key), patch);
      if (next) formats.set(key, next);
      else formats.delete(key);
    }
  });
}

/**
 * One cell's new state. `data` and `format` are applied only when the key is present;
 * `undefined` clears. Cells may be on different sheets (a cut that moves between sheets).
 */
export interface CellChange {
  sheetId: string;
  rowId: string;
  colId: string;
  data?: CellData | undefined;
  format?: CellFormat | undefined;
}

/** Applies many cell changes (content and/or format) as ONE transaction, hence one undo step. */
export function applyCellChanges(
  doc: Y.Doc,
  readOnly: boolean,
  changes: readonly CellChange[],
): boolean {
  if (changes.length === 0) return false;
  return transact(doc, readOnly, () => {
    for (const change of changes) {
      const { sheetId, rowId, colId } = change;
      if (getSheetName(doc, sheetId) === undefined) continue;
      if ("data" in change) setCell(doc, sheetId, rowId, colId, change.data);
      if ("format" in change) {
        const formats = getFormatsMap(doc, sheetId);
        const key = cellKey(rowId, colId);
        if (change.format && Object.keys(change.format).length > 0) formats.set(key, change.format);
        else formats.delete(key);
      }
    }
  });
}

export const MIN_COL_WIDTH = 20;
export const MAX_COL_WIDTH = 1000;
export const MIN_ROW_HEIGHT = 16;
export const MAX_ROW_HEIGHT = 500;

function clampSize(value: number, min: number, max: number): number | null {
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Stores a column width (clamped to 20-1000 px, whole pixels) in one transaction. Returns
 * false, writing nothing, when read-only, the sheet is gone, the value is not a number, or
 * the stored width is already that value.
 */
export function setColWidth(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  colId: string,
  width: number,
): boolean {
  const next = clampSize(width, MIN_COL_WIDTH, MAX_COL_WIDTH);
  if (next === null || getSheetName(doc, sheetId) === undefined) return false;
  const widths = getColWidthsMap(doc, sheetId);
  if (widths.get(colId) === next) return false;
  return transact(doc, readOnly, () => widths.set(colId, next));
}

/** Like `setColWidth`, for a row height (clamped to 16-500 px). */
export function setRowHeight(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  rowId: string,
  height: number,
): boolean {
  const next = clampSize(height, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT);
  if (next === null || getSheetName(doc, sheetId) === undefined) return false;
  const heights = getRowHeightsMap(doc, sheetId);
  if (heights.get(rowId) === next) return false;
  return transact(doc, readOnly, () => heights.set(rowId, next));
}

/** Outcome of a row/column insert or delete; `limit` and `last` carry what the user should be told. */
export type StructureResult =
  { ok: true; ids: string[] } | { ok: false; reason: "readOnly" | "notFound" | "limit" | "last" };

function insertAxis(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  at: number,
  count: number,
  insert: typeof insertRowsInDoc,
): StructureResult {
  if (readOnly) return { ok: false, reason: "readOnly" };
  if (getSheetName(doc, sheetId) === undefined) return { ok: false, reason: "notFound" };
  let ids: string[] | null = null;
  doc.transact(() => {
    ids = insert(doc, sheetId, at, count);
  }, LOCAL_ORIGIN);
  return ids ? { ok: true, ids } : { ok: false, reason: "limit" };
}

/** Inserts `count` rows so the first sits at visual index `at`, in one transaction (one undo step). */
export function insertRows(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  at: number,
  count: number,
): StructureResult {
  return insertAxis(doc, readOnly, sheetId, at, count, insertRowsInDoc);
}

/** Column counterpart of {@link insertRows}. */
export function insertCols(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  at: number,
  count: number,
): StructureResult {
  return insertAxis(doc, readOnly, sheetId, at, count, insertColsInDoc);
}

function deleteAxis(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  ids: readonly string[],
  remove: typeof deleteRowsInDoc,
): StructureResult {
  if (readOnly) return { ok: false, reason: "readOnly" };
  if (getSheetName(doc, sheetId) === undefined) return { ok: false, reason: "notFound" };
  let done = false;
  // The helper writes nothing when it refuses, so an empty transaction leaves no undo step.
  doc.transact(() => {
    done = remove(doc, sheetId, [...ids]);
  }, LOCAL_ORIGIN);
  return done ? { ok: true, ids: [...ids] } : { ok: false, reason: "last" };
}

/**
 * Deletes rows with their cells, formats and heights; formulas elsewhere are rewritten (ranges
 * shrink, single refs become #REF!). Refused (reason `last`) when no id matches or it would
 * leave no rows.
 */
export function deleteRows(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  rowIds: readonly string[],
): StructureResult {
  return deleteAxis(doc, readOnly, sheetId, rowIds, deleteRowsInDoc);
}

/** Column counterpart of {@link deleteRows}. */
export function deleteCols(
  doc: Y.Doc,
  readOnly: boolean,
  sheetId: string,
  colIds: readonly string[],
): StructureResult {
  return deleteAxis(doc, readOnly, sheetId, colIds, deleteColsInDoc);
}

export function useWorkbookMutations() {
  const { doc, readOnly } = useWorkbookDoc();
  return useMemo(
    () => ({
      addSheet: (afterSheetId?: string) => addSheet(doc, readOnly, afterSheetId),
      renameSheet: (sheetId: string, name: string) => renameSheet(doc, readOnly, sheetId, name),
      setSheetHidden: (sheetId: string, hidden: boolean) =>
        setSheetHidden(doc, readOnly, sheetId, hidden),
      deleteSheet: (sheetId: string) => deleteSheet(doc, readOnly, sheetId),
      moveSheet: (sheetId: string, toIndex: number) => moveSheet(doc, readOnly, sheetId, toIndex),
    }),
    [doc, readOnly],
  );
}
