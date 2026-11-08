import * as Y from "yjs";

// Shape of one workbook's Y.Doc (PROJECT_CONTEXT §3.1). The workbook name is
// deliberately absent: it lives in Postgres (workbooks.name).
//
// Writers here never open their own transaction (except createEmptyWorkbook),
// so callers can group several writes into the one doc.transact a user
// action requires.

export const SCHEMA_VERSION = 2;
// Ids for the default grid are created up front: creating them on first
// write lets two clients typing into row 5 of a fresh sheet each append their
// own ids, and Yjs keeps both appends.
export const DEFAULT_ROW_COUNT = 100;
export const DEFAULT_COL_COUNT = 26;
export const DEFAULT_SHEET_NAME = "Sheet1";

export type CellValue = string | number | boolean;
export interface CellData {
  v?: CellValue;
  /** Formula with id-based references, e.g. =[[r:k3f,c:9az]]+1 */
  f?: string;
}
export interface CellFormat {
  bg?: string;
  b?: true;
  i?: true;
  u?: true;
}

export type SheetMap = Y.Map<unknown>;

// Web Crypto exists in browsers and Node; shared compiles without DOM or Node
// types, so declare only the piece it uses.
declare const crypto: { randomUUID(): string };

export function newId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

export function cellKey(rowId: string, colId: string): string {
  return `${rowId}:${colId}`;
}

export function getMeta(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("meta");
}

export function getSheetOrderArray(doc: Y.Doc): Y.Array<string> {
  return doc.getArray<string>("sheetOrder");
}

export function getSheetsMap(doc: Y.Doc): Y.Map<SheetMap> {
  return doc.getMap<SheetMap>("sheets");
}

export function isWorkbookInitialized(doc: Y.Doc): boolean {
  return getMeta(doc).has("schemaVersion");
}

export function getSchemaVersion(doc: Y.Doc): number | undefined {
  const version = getMeta(doc).get("schemaVersion");
  return typeof version === "number" ? version : undefined;
}

// Yjs has no native move, so concurrent reorders can leave an id twice in an
// order array. Every client keeps the first occurrence, which is
// deterministic because all clients see the same merged array.
function dedupe(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function readSheetOrder(doc: Y.Doc): string[] {
  const sheets = getSheetsMap(doc);
  return dedupe(getSheetOrderArray(doc).toArray()).filter((id) => sheets.has(id));
}

export function getSheet(doc: Y.Doc, sheetId: string): SheetMap | undefined {
  return getSheetsMap(doc).get(sheetId);
}

function requireSheet(doc: Y.Doc, sheetId: string): SheetMap {
  const sheet = getSheet(doc, sheetId);
  if (!sheet) {
    throw new Error(`Unknown sheet ${sheetId}`);
  }
  return sheet;
}

function nested<T>(sheet: SheetMap, key: string): T {
  return sheet.get(key) as T;
}

function newIds(count: number): string[] {
  return Array.from({ length: count }, () => newId());
}

export interface AddSheetOptions {
  /** Insert right after this sheet in the order; at the end when absent or unknown. */
  afterSheetId?: string;
  /** Use this id instead of a fresh one (tests, deterministic callers). */
  sheetId?: string;
}

/**
 * Adds an empty sheet with the default grid and returns its id. A bare string
 * as the third argument is the sheet id (older call sites).
 */
export function addSheet(doc: Y.Doc, name: string, options: AddSheetOptions | string = {}): string {
  const { afterSheetId, sheetId = newId() } =
    typeof options === "string" ? { sheetId: options } : options;
  const sheet: SheetMap = new Y.Map();
  sheet.set("name", name);
  sheet.set("hidden", false);
  sheet.set("rowOrder", Y.Array.from(newIds(DEFAULT_ROW_COUNT)));
  sheet.set("colOrder", Y.Array.from(newIds(DEFAULT_COL_COUNT)));
  sheet.set("cells", new Y.Map<CellData>());
  sheet.set("formats", new Y.Map<CellFormat>());
  sheet.set("colWidths", new Y.Map<number>());
  sheet.set("rowHeights", new Y.Map<number>());
  getSheetsMap(doc).set(sheetId, sheet);
  const order = getSheetOrderArray(doc);
  const after = afterSheetId === undefined ? -1 : order.toArray().indexOf(afterSheetId);
  order.insert(after === -1 ? order.length : after + 1, [sheetId]);
  return sheetId;
}

// Only the server calls this, once, when a workbook has no stored state.
// If clients initialised docs too, two of them could each add a "Sheet1"
// and both would survive the merge.
export function createEmptyWorkbook(doc: Y.Doc): void {
  doc.transact(() => {
    getMeta(doc).set("schemaVersion", SCHEMA_VERSION);
    addSheet(doc, DEFAULT_SHEET_NAME);
  });
}

export function getSheetName(doc: Y.Doc, sheetId: string): string | undefined {
  const name = getSheet(doc, sheetId)?.get("name");
  return typeof name === "string" ? name : undefined;
}

export function setSheetName(doc: Y.Doc, sheetId: string, name: string): void {
  requireSheet(doc, sheetId).set("name", name);
}

export function isSheetHidden(doc: Y.Doc, sheetId: string): boolean {
  return getSheet(doc, sheetId)?.get("hidden") === true;
}

export function getRowOrderArray(doc: Y.Doc, sheetId: string): Y.Array<string> {
  return nested<Y.Array<string>>(requireSheet(doc, sheetId), "rowOrder");
}

export function getColOrderArray(doc: Y.Doc, sheetId: string): Y.Array<string> {
  return nested<Y.Array<string>>(requireSheet(doc, sheetId), "colOrder");
}

export function readRowOrder(doc: Y.Doc, sheetId: string): string[] {
  return dedupe(getRowOrderArray(doc, sheetId).toArray());
}

export function readColOrder(doc: Y.Doc, sheetId: string): string[] {
  return dedupe(getColOrderArray(doc, sheetId).toArray());
}

export function getCellsMap(doc: Y.Doc, sheetId: string): Y.Map<CellData> {
  return nested<Y.Map<CellData>>(requireSheet(doc, sheetId), "cells");
}

export function getFormatsMap(doc: Y.Doc, sheetId: string): Y.Map<CellFormat> {
  return nested<Y.Map<CellFormat>>(requireSheet(doc, sheetId), "formats");
}

export function getColWidthsMap(doc: Y.Doc, sheetId: string): Y.Map<number> {
  return nested<Y.Map<number>>(requireSheet(doc, sheetId), "colWidths");
}

export function getRowHeightsMap(doc: Y.Doc, sheetId: string): Y.Map<number> {
  return nested<Y.Map<number>>(requireSheet(doc, sheetId), "rowHeights");
}

export function getCell(
  doc: Y.Doc,
  sheetId: string,
  rowId: string,
  colId: string,
): CellData | undefined {
  return getCellsMap(doc, sheetId).get(cellKey(rowId, colId));
}

/** Pass `undefined` (or an empty object) to clear the cell. */
export function setCell(
  doc: Y.Doc,
  sheetId: string,
  rowId: string,
  colId: string,
  data: CellData | undefined,
): void {
  const cells = getCellsMap(doc, sheetId);
  const key = cellKey(rowId, colId);
  if (!data || (data.v === undefined && data.f === undefined)) {
    cells.delete(key);
  } else {
    cells.set(key, data);
  }
}

/**
 * Brings an initialized doc up to SCHEMA_VERSION in one transaction. Server
 * only, and the caller must persist the result immediately: a migration that
 * isn't stored could be redone with different ids and merge into duplicates.
 */
export function migrateWorkbook(doc: Y.Doc): boolean {
  const version = getSchemaVersion(doc);
  if (version === undefined || version >= SCHEMA_VERSION) return false;
  doc.transact(() => {
    for (const sheet of getSheetsMap(doc).values()) {
      const rows = nested<Y.Array<string>>(sheet, "rowOrder");
      const cols = nested<Y.Array<string>>(sheet, "colOrder");
      if (rows.length === 0) rows.push(newIds(DEFAULT_ROW_COUNT));
      if (cols.length === 0) cols.push(newIds(DEFAULT_COL_COUNT));
    }
    getMeta(doc).set("schemaVersion", SCHEMA_VERSION);
  });
  return true;
}

/** True when a sheet (hidden ones included) already uses this name, ignoring case. */
export function isSheetNameTaken(doc: Y.Doc, name: string, exceptSheetId?: string): boolean {
  const wanted = name.trim().toLowerCase();
  for (const id of getSheetsMap(doc).keys()) {
    if (id !== exceptSheetId && getSheetName(doc, id)?.toLowerCase() === wanted) return true;
  }
  return false;
}

/** The first unused default name: Sheet1, Sheet2, ... */
export function nextSheetName(doc: Y.Doc): string {
  for (let n = 1; ; n++) {
    const name = `Sheet${n}`;
    if (!isSheetNameTaken(doc, name)) return name;
  }
}

export function setSheetHidden(doc: Y.Doc, sheetId: string, hidden: boolean): void {
  requireSheet(doc, sheetId).set("hidden", hidden);
}

/**
 * Removes the sheet and every occurrence of its id from the order (concurrent
 * moves can leave duplicates). Callers forbid deleting the last visible sheet
 * (see `hasOtherVisibleSheet`); concurrent deletes are repaired by the server.
 */
export function deleteSheet(doc: Y.Doc, sheetId: string): void {
  getSheetsMap(doc).delete(sheetId);
  removeFromOrder(getSheetOrderArray(doc), sheetId);
}

function removeFromOrder(order: Y.Array<string>, sheetId: string): void {
  for (let i = order.length - 1; i >= 0; i--) {
    if (order.get(i) === sheetId) order.delete(i, 1);
  }
}

/**
 * Moves a sheet so it sits at `toIndex` in `readSheetOrder` terms (deduped,
 * only existing sheets; clamped to the valid range). Yjs has no move: all
 * occurrences are deleted and one is inserted, in the caller's transaction.
 * Concurrent moves of the same sheet may both insert; readers keep the first
 * occurrence, so every client agrees.
 */
export function moveSheet(doc: Y.Doc, sheetId: string, toIndex: number): void {
  const others = readSheetOrder(doc).filter((id) => id !== sheetId);
  const target = Math.max(0, Math.min(Math.trunc(toIndex), others.length));
  const order = getSheetOrderArray(doc);
  removeFromOrder(order, sheetId);
  // Insert just before the first raw occurrence of the sheet that should follow
  // it: everything readers see before that point is exactly others[0..target).
  const follower = others[target];
  const position = follower === undefined ? order.length : order.toArray().indexOf(follower);
  order.insert(position, [sheetId]);
}

/**
 * Non-hidden sheets in order. If sheets exist but all are hidden (concurrent
 * hides), the first sheet counts as visible: a read rule, nothing is written.
 */
export function readVisibleSheetOrder(doc: Y.Doc): string[] {
  const order = readSheetOrder(doc);
  const visible = order.filter((id) => !isSheetHidden(doc, id));
  const [first] = order;
  return visible.length === 0 && first !== undefined ? [first] : visible;
}

/**
 * True when some sheet other than `sheetId` is not hidden, i.e. hiding or
 * deleting `sheetId` still leaves a visible sheet. Callers use it to forbid
 * hiding/deleting the last visible sheet.
 */
export function hasOtherVisibleSheet(doc: Y.Doc, sheetId: string): boolean {
  return readSheetOrder(doc).some((id) => id !== sheetId && !isSheetHidden(doc, id));
}

/**
 * Server-only repair: an initialized workbook with no sheets (two users
 * concurrently deleted the last two) gets one new sheet, in one transaction.
 * Returns whether it wrote. Only the server may do this, for the same reason
 * as `createEmptyWorkbook`: if every client repaired, each would add a sheet
 * and all of them would survive the merge. Idempotent: a second call finds a
 * sheet and does nothing.
 */
export function ensureWorkbookHasSheet(doc: Y.Doc, origin?: unknown): boolean {
  if (!isWorkbookInitialized(doc) || readSheetOrder(doc).length > 0) return false;
  doc.transact(() => {
    addSheet(doc, nextSheetName(doc));
  }, origin);
  return true;
}
