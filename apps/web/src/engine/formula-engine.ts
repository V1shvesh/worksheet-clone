import {
  CellError,
  DetailedCellError,
  ErrorType,
  HyperFormula,
  type CellValue,
  type ExportedChange,
} from "hyperformula";
import type * as Y from "yjs";
import {
  decodeFormula,
  formatSheetPrefix,
  getCellsMap,
  getColOrderArray,
  getRowOrderArray,
  getSheetOrderArray,
  getSheetsMap,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  referencedSheetIds,
  type CellData,
  type IdLookup,
} from "@worksheet-clone/shared";
import { lookupSheetIndex } from "./sheet-index";

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
function toRawContent(
  sheetId: string,
  data: CellData,
  lookup: (sheetId: string) => IdLookup | undefined,
): string | number | boolean | null {
  if (data.f !== undefined) {
    return decodeFormula(data.f, {
      sheetId,
      lookup,
      // HyperFormula names its sheets by id, which may start with a digit: always quote.
      sheetPrefix: (id) => formatSheetPrefix(id, { alwaysQuote: true }),
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

export interface FormulaEngineOptions {
  /** Test seam: an engine instance to use instead of a fresh HyperFormula (e.g. one rigged to throw). */
  hyperFormula?: HyperFormula;
}

/** A burst of failures (one per transaction while the engine is broken) is logged once per this long. */
const LOG_BURST_MS = 2000;

export function createFormulaEngine(doc: Y.Doc, options: FormulaEngineOptions = {}): FormulaEngine {
  // evaluateNullToZero: a reference to an empty cell is 0, as in Excel and
  // Google Sheets (HyperFormula's default shows it as empty).
  const hf =
    options.hyperFormula ??
    HyperFormula.buildEmpty({ licenseKey: "gpl-v3", evaluateNullToZero: true });
  // Sheets HyperFormula couldn't load: their cells read as #ERROR! until a later reload works.
  const failed = new Set<string>();
  let lastLogged = -Infinity;
  function report(message: string, error: unknown): void {
    const now = Date.now();
    if (now - lastLogged < LOG_BURST_MS) return;
    lastLogged = now;
    console.error(message, error);
  }
  // The HF sheet name is our sheet id, so renames never touch the engine.
  const sheets = new Map<string, SheetState>();
  const sheetIdByHfId = new Map<number, string>();
  const listeners = new Set<(event: EngineEvent) => void>();

  // Row/column indices of any sheet, read from the doc once per update (the
  // doc is the truth even for sheets the engine has not reloaded yet). A
  // formula can point into a sheet whose order changed in the same transaction.
  let lookupCache = new Map<string, IdLookup | undefined>();
  function lookup(id: string): IdLookup | undefined {
    if (!lookupCache.has(id)) lookupCache.set(id, lookupSheetIndex(doc, id));
    return lookupCache.get(id);
  }

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
      const raw = toRawContent(sheetId, data, lookup);
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
    const index: SheetIndex = {
      rows: indexOf(readRowOrder(doc, sheetId)),
      cols: indexOf(readColOrder(doc, sheetId)),
    };
    // A failed earlier attempt may have added the sheet to HyperFormula without recording it.
    let hfId = existing?.hfId ?? hf.getSheetId(sheetId);
    if (hfId === undefined) hfId = hf.getSheetId(hf.addSheet(sheetId))!;
    sheetIdByHfId.set(hfId, sheetId);
    // Recorded before the content is set: if that throws, the sheet still exists for the
    // grid (showing #ERROR!) and the next transaction retries the reload.
    sheets.set(sheetId, {
      hfId,
      ...index,
      cellsMap: getCellsMap(doc, sheetId),
      rowArray: getRowOrderArray(doc, sheetId),
      colArray: getColOrderArray(doc, sheetId),
    });
    try {
      hf.setSheetContent(hfId, buildContent(sheetId, index));
    } catch (error) {
      failed.add(sheetId);
      throw error;
    }
    failed.delete(sheetId);
  }

  /** loadSheet that never throws: a sheet that can't load is marked failed (cells show #ERROR!). */
  function loadSheetSafely(sheetId: string): void {
    try {
      loadSheet(sheetId);
    } catch (error) {
      failed.add(sheetId);
      report(`Formula engine could not load sheet ${sheetId}; its cells show #ERROR!`, error);
    }
  }

  function removeSheet(sheetId: string): void {
    const state = sheets.get(sheetId);
    if (!state) return;
    hf.removeSheet(state.hfId);
    sheetIdByHfId.delete(state.hfId);
    sheets.delete(sheetId);
  }

  /**
   * Re-sets every formula outside `reindexed` whose stored text references one
   * of those sheets. HyperFormula keeps references by sheet name, but the
   * decoded A1 text depends on the target's row/column order, which we own.
   */
  function redecodeReferences(reindexed: Set<string>, touched: Map<string, EngineCell[]>): void {
    for (const [sheetId, state] of sheets) {
      if (reindexed.has(sheetId)) continue;
      for (const [key, data] of state.cellsMap) {
        if (data.f === undefined) continue;
        let affected = false;
        for (const id of referencedSheetIds(data.f)) {
          if (reindexed.has(id)) {
            affected = true;
            break;
          }
        }
        if (!affected) continue;
        const [rowId, colId] = key.split(":");
        const row = state.rows.get(rowId ?? "");
        const col = state.cols.get(colId ?? "");
        if (row === undefined || col === undefined) continue;
        hf.setCellContents({ sheet: state.hfId, row, col }, [
          [toRawContent(sheetId, data, lookup)],
        ]);
        let list = touched.get(sheetId);
        if (!list) touched.set(sheetId, (list = []));
        list.push({ row, col });
      }
    }
  }

  function emit(event: EngineEvent): void {
    // A throwing listener must not stop the others, nor escape into Yjs's observer chain.
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        report("Formula engine listener failed", error);
      }
    }
  }

  /** Sheets whose engine state a failed transaction may have left wrong: the changed ones and their dependants. */
  function affectedSheets(tr: Y.Transaction, sheetSetChanged: boolean): string[] {
    const order = readSheetOrder(doc);
    if (sheetSetChanged) return order;
    const changed = new Set<string>();
    for (const [sheetId, state] of sheets) {
      if (
        isChanged(tr, state.cellsMap) ||
        isChanged(tr, state.rowArray) ||
        isChanged(tr, state.colArray) ||
        failed.has(sheetId)
      ) {
        changed.add(sheetId);
      }
    }
    const affected = new Set(changed);
    for (const [sheetId, state] of sheets) {
      if (affected.has(sheetId)) continue;
      for (const data of state.cellsMap.values()) {
        if (data.f !== undefined && [...referencedSheetIds(data.f)].some((id) => changed.has(id))) {
          affected.add(sheetId);
          break;
        }
      }
    }
    return order.filter((id) => affected.has(id));
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
    lookupCache = new Map();
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
          if (
            failed.has(sheetId) ||
            isChanged(tr, state.rowArray) ||
            isChanged(tr, state.colArray)
          ) {
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
            const raw = data ? toRawContent(sheetId, data, lookup) : null;
            hf.setCellContents({ sheet: state.hfId, row, col }, [[raw]]);
            let list = touched.get(sheetId);
            if (!list) touched.set(sheetId, (list = []));
            list.push({ row, col });
          }
        }
        // A rebuilt sheet has new row/column indices (or just appeared), so
        // formulas elsewhere that point into it must be decoded again.
        if (rebuilt.size > 0 && sheets.size > 1) redecodeReferences(rebuilt, touched);
      });
    } catch (error) {
      // The engine must never take the grid down, nor throw into Yjs's observer chain (that
      // would skip other observers and the transaction cleanup): reload the affected sheets one
      // by one; one that still fails shows #ERROR! instead of taking the others with it.
      report("Formula engine update failed; reloading the affected sheets", error);
      changes = [];
      touched.clear();
      for (const id of affectedSheets(tr, sheetSetChanged)) {
        loadSheetSafely(id);
        rebuilt.add(id);
      }
    }
    for (const sheetId of rebuilt) emit({ type: "rebuilt", sheetId });
    for (const [sheetId, cells] of groupChanges(changes, touched, rebuilt)) {
      emit({ type: "cells", sheetId, cells: [...cells.values()] });
    }
  }

  for (const id of readSheetOrder(doc)) loadSheetSafely(id);
  lookupCache = new Map();
  doc.on("afterTransaction", onAfterTransaction);

  return {
    getValue(sheetId, row, col) {
      const state = sheets.get(sheetId);
      if (!state || row < 0 || col < 0) return null;
      if (failed.has(sheetId))
        return new DetailedCellError(new CellError(ErrorType.ERROR), "#ERROR!");
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
