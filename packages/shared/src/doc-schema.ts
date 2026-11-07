import * as Y from "yjs";

// Shape of one workbook's Y.Doc (PROJECT_CONTEXT §3.1). The workbook name is
// deliberately absent: it lives in Postgres (workbooks.name).
//
// Writers here never open their own transaction (except createEmptyWorkbook),
// so callers can group several writes into the one doc.transact a user
// action requires.

export const SCHEMA_VERSION = 1;
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

export function addSheet(doc: Y.Doc, name: string, sheetId: string = newId()): string {
  const sheet: SheetMap = new Y.Map();
  sheet.set("name", name);
  sheet.set("hidden", false);
  sheet.set("rowOrder", new Y.Array<string>());
  sheet.set("colOrder", new Y.Array<string>());
  sheet.set("cells", new Y.Map<CellData>());
  sheet.set("formats", new Y.Map<CellFormat>());
  sheet.set("colWidths", new Y.Map<number>());
  sheet.set("rowHeights", new Y.Map<number>());
  getSheetsMap(doc).set(sheetId, sheet);
  getSheetOrderArray(doc).push([sheetId]);
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
