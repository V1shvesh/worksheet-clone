import { HyperFormula, type CellValue, type ExportedChange } from "hyperformula";
import type * as Y from "yjs";
import {
  decodeFormula,
  getCellsMap,
  getColOrderArray,
  getRowOrderArray,
  getSheetOrderArray,
  getSheetsMap,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  type CellData,
} from "@worksheet-clone/shared";

export type EngineValue = CellValue;

export interface EngineCell {
  row: number;
  col: number;
}

export type EngineEvent =
  /** Computed values changed at these visual indices (one event per sheet per transaction). */
  | { type: "cells"; sheetId: string; cells: EngineCell[] }
  /** The whole sheet was reloaded; every cell may have changed. */
  | { type: "rebuilt"; sheetId: string };

export interface FormulaEngine {
  getValue(sheetId: string, row: number, col: number): EngineValue;
  subscribe(listener: (event: EngineEvent) => void): () => void;
  destroy(): void;
}

// HyperFormula parses raw strings ("007" becomes 7, "TRUE" a boolean, "=x" a
// formula). A leading apostrophe makes it keep the rest as plain text.
function toRawContent(data: CellData, lookup: SheetIndex): string | number | boolean | null {
  if (data.f !== undefined) {
    return decodeFormula(data.f, {
      rowIndex: (id) => lookup.rows.get(id),
      colIndex: (id) => lookup.cols.get(id),
    });
  }
  if (typeof data.v === "string") return `'${data.v}`;
  return data.v ?? null;
}

interface SheetIndex {
  rows: Map<string, number>;
  cols: Map<string, number>;
}

interface SheetState extends SheetIndex {
  hfId: number;
  // Identity of the Yjs types this state was built from; a replaced sheet map
  // (remove + re-add under one id) must rebuild.
  cellsMap: Y.Map<CellData>;
  rowArray: Y.Array<string>;
  colArray: Y.Array<string>;
}

function indexOf(ids: string[]): Map<string, number> {
  return new Map(ids.map((id, i) => [id, i]));
}

export function createFormulaEngine(doc: Y.Doc): FormulaEngine {
  // evaluateNullToZero: a reference to an empty cell is 0, as in Excel and
  // Google Sheets (HyperFormula's default shows it as empty).
  const hf = HyperFormula.buildEmpty({ licenseKey: "gpl-v3", evaluateNullToZero: true });
  // The HF sheet name is our sheet id, so renames never touch the engine.
  const sheets = new Map<string, SheetState>();
  const sheetIdByHfId = new Map<number, string>();
  const listeners = new Set<(event: EngineEvent) => void>();

  function buildContent(
    sheetId: string,
    index: SheetIndex,
  ): (string | number | boolean | null)[][] {
    const content: (string | number | boolean | null)[][] = [];
    for (const [key, data] of getCellsMap(doc, sheetId)) {
      const [rowId, colId] = key.split(":");
      const row = index.rows.get(rowId ?? "");
      const col = index.cols.get(colId ?? "");
      if (row === undefined || col === undefined) continue; // orphan of a deleted row/column
      const raw = toRawContent(data, index);
      if (raw === null) continue;
      (content[row] ??= [])[col] = raw;
    }
    // setSheetContent needs a dense matrix.
    for (let r = 0; r < content.length; r++) {
      const line = (content[r] ??= []);
      for (let c = 0; c < line.length; c++) line[c] ??= null;
    }
    return content;
  }

  function loadSheet(sheetId: string): void {
    const existing = sheets.get(sheetId);
    const rowArray = getRowOrderArray(doc, sheetId);
    const colArray = getColOrderArray(doc, sheetId);
    const index: SheetIndex = {
      rows: indexOf(readRowOrder(doc, sheetId)),
      cols: indexOf(readColOrder(doc, sheetId)),
    };
    const content = buildContent(sheetId, index);
    let hfId: number;
    if (existing) {
      hfId = existing.hfId;
    } else {
      hfId = hf.getSheetId(hf.addSheet(sheetId))!;
      sheetIdByHfId.set(hfId, sheetId);
    }
    hf.setSheetContent(hfId, content);
    sheets.set(sheetId, {
      hfId,
      ...index,
      cellsMap: getCellsMap(doc, sheetId),
      rowArray,
      colArray,
    });
  }

  function removeSheet(sheetId: string): void {
    const state = sheets.get(sheetId);
    if (!state) return;
    hf.removeSheet(state.hfId);
    sheetIdByHfId.delete(state.hfId);
    sheets.delete(sheetId);
  }

  function emit(event: EngineEvent): void {
    for (const listener of [...listeners]) listener(event);
  }

  function groupChanges(
    changes: ExportedChange[],
    extra: Map<string, EngineCell[]>,
    skip: Set<string>,
  ): Map<string, Map<string, EngineCell>> {
    const bySheet = new Map<string, Map<string, EngineCell>>();
    const add = (sheetId: string, cell: EngineCell) => {
      if (skip.has(sheetId) || !sheets.has(sheetId)) return;
      let cells = bySheet.get(sheetId);
      if (!cells) bySheet.set(sheetId, (cells = new Map()));
      cells.set(`${cell.row}:${cell.col}`, cell);
    };
    for (const change of changes) {
      if (!("address" in change)) continue;
      const sheetId = sheetIdByHfId.get(change.address.sheet);
      if (sheetId) add(sheetId, { row: change.address.row, col: change.address.col });
    }
    // Reported even if HF considers the value unchanged (e.g. 1 re-entered as 1).
    for (const [sheetId, cells] of extra) for (const cell of cells) add(sheetId, cell);
    return bySheet;
  }

  // Y.Transaction.changed is keyed by AbstractType<YEvent<any>>, which concrete
  // Y.Map/Y.Array types are not assignable to; widen once here.
  type Changeable = Parameters<Y.Transaction["changed"]["has"]>[0];
  function isChanged(tr: Y.Transaction, type: unknown): boolean {
    return tr.changed.has(type as unknown as Changeable);
  }

  function onAfterTransaction(tr: Y.Transaction): void {
    const sheetSetChanged =
      isChanged(tr, getSheetsMap(doc)) || isChanged(tr, getSheetOrderArray(doc));
    const rebuilt = new Set<string>();
    const touched = new Map<string, EngineCell[]>();
    let changes: ExportedChange[] = [];
    try {
      changes = hf.batch(() => {
        if (sheetSetChanged) {
          const wanted = new Set(readSheetOrder(doc));
          for (const id of [...sheets.keys()]) if (!wanted.has(id)) removeSheet(id);
          for (const id of wanted) {
            const state = sheets.get(id);
            if (!state || state.cellsMap !== getCellsMap(doc, id)) {
              loadSheet(id);
              rebuilt.add(id);
            }
          }
        }
        for (const [sheetId, state] of sheets) {
          if (rebuilt.has(sheetId)) continue;
          if (isChanged(tr, state.rowArray) || isChanged(tr, state.colArray)) {
            loadSheet(sheetId);
            rebuilt.add(sheetId);
            continue;
          }
          const keys = tr.changed.get(state.cellsMap as unknown as Changeable);
          if (!keys) continue;
          for (const key of keys) {
            if (key === null) continue;
            const [rowId, colId] = key.split(":");
            const row = state.rows.get(rowId ?? "");
            const col = state.cols.get(colId ?? "");
            if (row === undefined || col === undefined) continue;
            const data = state.cellsMap.get(key);
            const raw = data ? toRawContent(data, state) : null;
            hf.setCellContents({ sheet: state.hfId, row, col }, [[raw]]);
            let list = touched.get(sheetId);
            if (!list) touched.set(sheetId, (list = []));
            list.push({ row, col });
          }
        }
      });
    } catch (error) {
      // The engine must never take the grid down; fall back to a full reload.
      console.error("Formula engine update failed; rebuilding", error);
      try {
        for (const id of readSheetOrder(doc)) {
          loadSheet(id);
          rebuilt.add(id);
        }
      } catch (fatal) {
        console.error("Formula engine rebuild failed", fatal);
      }
    }
    for (const sheetId of rebuilt) emit({ type: "rebuilt", sheetId });
    for (const [sheetId, cells] of groupChanges(changes, touched, rebuilt)) {
      emit({ type: "cells", sheetId, cells: [...cells.values()] });
    }
  }

  for (const id of readSheetOrder(doc)) loadSheet(id);
  doc.on("afterTransaction", onAfterTransaction);

  return {
    getValue(sheetId, row, col) {
      const state = sheets.get(sheetId);
      if (!state || row < 0 || col < 0) return null;
      try {
        return hf.getCellValue({ sheet: state.hfId, row, col });
      } catch {
        return null;
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      doc.off("afterTransaction", onAfterTransaction);
      listeners.clear();
      hf.destroy();
    },
  };
}
