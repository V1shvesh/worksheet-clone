// Pure planning for copy and paste: (selection, model) -> clipboard flavors, and
// (clipboard contents, target) -> the cells to write. No Yjs, no Redux, no DOM.

import { shiftFormula } from "@worksheet-clone/shared";
import { parseCellInput } from "../commands/parse-cell-input";
import type { CellCoord, CellRange, CellRenderData } from "../port";
import {
  serializeClipboardHtml,
  type ClipboardPayload,
  type ClipCell,
  type ClipFormat,
} from "./clipboard-html";
import { serializeTsv } from "./tsv";

/** The part of a DataTransfer we use (a plain object works in tests). */
export interface ClipboardDataLike {
  getData(type: string): string;
  setData(type: string, value: string): void;
}

/** A paste or fill larger than this many cells is refused. */
export const MAX_PASTE_CELLS = 10_000;

export interface CopyModel {
  getCell(c: CellCoord): CellRenderData;
  getRawInput(c: CellCoord): string;
}

export interface CopyResult {
  text: string;
  html: string;
  payload: ClipboardPayload;
}

/** text/plain = displayed values (TSV); text/html = displayed table + raw inputs and formats. */
export function buildCopy(
  model: CopyModel,
  sheetId: string,
  range: CellRange,
  cut: boolean,
): CopyResult {
  const cells: (ClipCell | null)[][] = [];
  const display: string[][] = [];
  for (let row = range.start.row; row <= range.end.row; row++) {
    const cellRow: (ClipCell | null)[] = [];
    const displayRow: string[] = [];
    for (let col = range.start.col; col <= range.end.col; col++) {
      const coord = { row, col };
      const input = model.getRawInput(coord);
      const shown = model.getCell(coord);
      const format = shown.format as ClipFormat | undefined;
      displayRow.push(shown.text);
      cellRow.push(input === "" && !format ? null : { input, ...(format ? { format } : {}) });
    }
    cells.push(cellRow);
    display.push(displayRow);
  }
  const source = { sheetId, row: range.start.row, col: range.start.col };
  const payload: ClipboardPayload = { v: 1, source, cut, cells };
  return {
    text: serializeTsv(display),
    html: serializeClipboardHtml({ source, cut, cells, display }),
    payload,
  };
}

/** One destination cell of a paste. `format`: undefined leaves it, null clears it. */
export interface PasteEntry {
  row: number;
  col: number;
  input: string;
  format?: ClipFormat | null;
}

export type PasteSource =
  { kind: "ours"; payload: ClipboardPayload } | { kind: "text"; rows: string[][] };

export type PastePlan =
  { kind: "ok"; entries: PasteEntry[]; range: CellRange; clipped: boolean } | { kind: "tooLarge" };

function sourceSize(source: PasteSource): { rows: number; cols: number } {
  const grid = source.kind === "ours" ? source.payload.cells : source.rows;
  return { rows: grid.length, cols: grid[0]?.length ?? 0 };
}

/**
 * Where each source cell lands. Starts at `anchor`; a single source cell pasted over a
 * larger `selection` fills the whole selection instead, each target shifted relative to
 * its own position. Cells past the sheet are dropped (`clipped`).
 */
export function planPaste(args: {
  source: PasteSource;
  anchor: CellCoord;
  selection: CellRange;
  dims: { rowCount: number; colCount: number };
}): PastePlan {
  const { source, anchor, selection, dims } = args;
  const size = sourceSize(source);
  if (size.rows === 0 || size.cols === 0) return { kind: "tooLarge" };
  const selRows = selection.end.row - selection.start.row + 1;
  const selCols = selection.end.col - selection.start.col + 1;
  const fill = size.rows === 1 && size.cols === 1 && selRows * selCols > 1;
  const origin = fill ? selection.start : anchor;
  const rows = fill ? selRows : size.rows;
  const cols = fill ? selCols : size.cols;
  if (rows * cols > MAX_PASTE_CELLS) return { kind: "tooLarge" };

  const entries: PasteEntry[] = [];
  let clipped = false;
  for (let dr = 0; dr < rows; dr++) {
    for (let dc = 0; dc < cols; dc++) {
      const row = origin.row + dr;
      const col = origin.col + dc;
      if (row >= dims.rowCount || col >= dims.colCount) {
        clipped = true;
        continue;
      }
      const sr = fill ? 0 : dr;
      const sc = fill ? 0 : dc;
      if (source.kind === "text") {
        entries.push({ row, col, input: source.rows[sr]?.[sc] ?? "" });
        continue;
      }
      const cell = source.payload.cells[sr]?.[sc] ?? null;
      const from = source.payload.source;
      entries.push({
        row,
        col,
        input: cell
          ? shiftInput(cell.input, row - (from.row + sr), col - (from.col + sc), dims)
          : "",
        format: cell?.format ?? null,
      });
    }
  }
  if (entries.length === 0) return { kind: "ok", entries, range: selection, clipped };
  return {
    kind: "ok",
    entries,
    range: {
      start: { row: origin.row, col: origin.col },
      end: {
        row: Math.min(origin.row + rows, dims.rowCount) - 1,
        col: Math.min(origin.col + cols, dims.colCount) - 1,
      },
    },
    clipped,
  };
}

/** Shifts a raw input like a copy-paste; only formulas change (text like `'=x` does not). */
export function shiftInput(
  input: string,
  rows: number,
  cols: number,
  dims: { rowCount: number; colCount: number },
): string {
  if (rows === 0 && cols === 0) return input;
  const parsed = parseCellInput(input);
  return parsed.kind === "formula" ? shiftFormula(parsed.a1, rows, cols, dims) : input;
}
