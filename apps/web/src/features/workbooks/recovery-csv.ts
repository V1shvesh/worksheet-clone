import type * as Y from "yjs";
import {
  decodeFormula,
  formatSheetPrefix,
  getCellsMap,
  getSheetName,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  type CellData,
} from "@worksheet-clone/shared";
import { lookupSheetIndex } from "../../engine/sheet-index";

// Built from the code point: a literal BOM in source is invisible (and Prettier rewrites the escape).
const BOM = String.fromCharCode(0xfeff);

/** RFC 4180: a field with a comma, quote or line break is quoted, quotes are doubled, rows end in CRLF. */
export function toCsv(rows: string[][]): string {
  const field = (value: string) =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return rows.map((row) => row.map(field).join(",") + "\r\n").join("");
}

/** The cell as the user would type it: formulas as A1 text, booleans as TRUE/FALSE, text as is. */
function rawText(doc: Y.Doc, sheetId: string, data: CellData): string {
  if (data.f !== undefined) {
    return decodeFormula(data.f, {
      sheetId,
      lookup: (id) => lookupSheetIndex(doc, id),
      sheetPrefix: (id) => formatSheetPrefix(getSheetName(doc, id) ?? id),
    });
  }
  if (typeof data.v === "boolean") return data.v ? "TRUE" : "FALSE";
  return data.v === undefined ? "" : String(data.v);
}

/**
 * The sheet's raw inputs from the top-left corner to its last non-empty cell (no pages of empty
 * rows), or [] when every cell is empty. Cells whose row or column no longer exists are skipped.
 */
export function sheetRows(doc: Y.Doc, sheetId: string): string[][] {
  const rowIndex = new Map(readRowOrder(doc, sheetId).map((id, i) => [id, i]));
  const colIndex = new Map(readColOrder(doc, sheetId).map((id, i) => [id, i]));
  const filled = new Map<string, string>();
  let lastRow = -1;
  let lastCol = -1;
  for (const [key, data] of getCellsMap(doc, sheetId).entries()) {
    const [rowId = "", colId = ""] = key.split(":");
    const row = rowIndex.get(rowId);
    const col = colIndex.get(colId);
    if (row === undefined || col === undefined) continue;
    const text = rawText(doc, sheetId, data);
    if (text === "") continue;
    filled.set(`${row}:${col}`, text);
    lastRow = Math.max(lastRow, row);
    lastCol = Math.max(lastCol, col);
  }
  return Array.from({ length: lastRow + 1 }, (_r, row) =>
    Array.from({ length: lastCol + 1 }, (_c, col) => filled.get(`${row}:${col}`) ?? ""),
  );
}

export interface RecoveryFile {
  fileName: string;
  content: string;
}

/** Characters no common file system accepts in a name. */
function safeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned === "" ? "Untitled" : cleaned;
}

/**
 * One CSV per sheet that has any non-empty cell, named `<workbook> - <sheet>.csv`.
 *
 * Why every non-empty sheet and not only "the cells that were not saved": the replica cannot be
 * diffed against the server (we were cut off from it), so the honest export is everything this
 * browser holds, and the user compares it with what the server shows after the reload.
 * Sheets that have been deleted are not exported (they are not in the sheet order).
 */
export function recoveryFiles(doc: Y.Doc, workbookName: string): RecoveryFile[] {
  const used = new Set<string>();
  const files: RecoveryFile[] = [];
  for (const sheetId of readSheetOrder(doc)) {
    const rows = sheetRows(doc, sheetId);
    if (rows.length === 0) continue;
    const base = safeFileName(`${workbookName} - ${getSheetName(doc, sheetId) ?? sheetId}`);
    let fileName = `${base}.csv`;
    for (let n = 2; used.has(fileName.toLowerCase()); n++) fileName = `${base} (${n}).csv`;
    used.add(fileName.toLowerCase());
    // The BOM makes Excel read the file as UTF-8.
    files.push({ fileName, content: BOM + toCsv(rows) });
  }
  return files;
}

/** Saves each file through a temporary `<a download>` (a browser may ask before saving several). */
export function downloadFiles(files: RecoveryFile[]): void {
  for (const { fileName, content } of files) {
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
