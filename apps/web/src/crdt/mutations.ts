import { useMemo } from "react";
import type * as Y from "yjs";
import {
  addSheet as addSheetToDoc,
  deleteSheet as deleteSheetFromDoc,
  getSheetName,
  hasOtherVisibleSheet,
  isSheetHidden,
  isSheetNameTaken,
  moveSheet as moveSheetInDoc,
  nextSheetName,
  setCell,
  setSheetHidden as setSheetHiddenInDoc,
  setSheetName,
  sheetNameSchema,
  type CellData,
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
