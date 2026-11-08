import type * as Y from "yjs";
import {
  cellKey,
  colIndexToLabel,
  decodeFormula,
  formatSheetPrefix,
  getCellsMap,
  getColOrderArray,
  getColWidthsMap,
  getFormatsMap,
  getRowHeightsMap,
  getRowOrderArray,
  getSheetName,
  readColOrder,
  readRowOrder,
  type CellFormat,
} from "@worksheet-clone/shared";
import { lookupSheetIndex, type EngineValue, type FormulaEngine } from "../../../engine";
import { parseCellInput } from "../commands/parse-cell-input";
import type { CellCoord, CellRenderData, GridDimensions } from "../port";

export const DEFAULT_ROW_HEIGHT = 24;
export const DEFAULT_COL_WIDTH = 100;

export type ModelEvent = { type: "cells"; cells: CellCoord[] } | { type: "dimensions" };

/** Display text for a computed value; 15 significant digits hides float noise (0.1+0.2). */
function displayValue(value: EngineValue): { text: string; error?: true } {
  if (value === null || value === undefined) return { text: "" };
  if (typeof value === "number") return { text: String(Number(value.toPrecision(15))) };
  if (typeof value === "boolean") return { text: value ? "TRUE" : "FALSE" };
  if (typeof value === "string") return { text: value };
  return { text: value.value, error: true };
}

/**
 * The only place that translates visual indices to row/col ids for the grid
 * (ADR-0001). Reads Yjs and the formula engine; never writes.
 */
export class SheetViewModel {
  private rowIds: string[] = [];
  private colIds: string[] = [];
  private rowIndexById = new Map<string, number>();
  private colIndexById = new Map<string, number>();
  private listeners = new Set<(event: ModelEvent) => void>();
  private pendingFormatKeys = new Set<string>();
  private dimensionsDirty = false;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly doc: Y.Doc,
    readonly sheetId: string,
    private readonly engine: FormulaEngine,
  ) {
    this.reloadOrders();

    const observe = <E>(
      type: { observe(h: (e: E) => void): void; unobserve(h: (e: E) => void): void },
      handler: (event: E) => void,
    ) => {
      type.observe(handler);
      this.cleanups.push(() => type.unobserve(handler));
    };
    const sizeChanged = () => (this.dimensionsDirty = true);
    // Order changes reload the id caches now but notify only when the engine
    // reports its rebuild: observers run before the engine's afterTransaction
    // handler, and a refresh sent earlier would paint stale values.
    const ordersChanged = () => this.reloadOrders();
    observe(getRowOrderArray(doc, sheetId), ordersChanged);
    observe(getColOrderArray(doc, sheetId), ordersChanged);
    observe(getRowHeightsMap(doc, sheetId), sizeChanged);
    observe(getColWidthsMap(doc, sheetId), sizeChanged);
    observe(getFormatsMap(doc, sheetId), (event: Y.YMapEvent<CellFormat>) => {
      for (const key of event.keysChanged) this.pendingFormatKeys.add(key);
    });

    const onAfterTransaction = () => this.flush();
    doc.on("afterTransaction", onAfterTransaction);
    this.cleanups.push(() => doc.off("afterTransaction", onAfterTransaction));

    this.cleanups.push(
      engine.subscribe((event) => {
        if (event.sheetId !== sheetId) return;
        if (event.type === "cells") this.emit({ type: "cells", cells: event.cells });
        else this.emit({ type: "dimensions" });
      }),
    );
  }

  private reloadOrders(): void {
    this.rowIds = readRowOrder(this.doc, this.sheetId);
    this.colIds = readColOrder(this.doc, this.sheetId);
    this.rowIndexById = new Map(this.rowIds.map((id, i) => [id, i]));
    this.colIndexById = new Map(this.colIds.map((id, i) => [id, i]));
  }

  private emit(event: ModelEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private flush(): void {
    if (this.dimensionsDirty) {
      this.dimensionsDirty = false;
      this.emit({ type: "dimensions" });
    }
    if (this.pendingFormatKeys.size === 0) return;
    const cells: CellCoord[] = [];
    for (const key of this.pendingFormatKeys) {
      const [rowId, colId] = key.split(":");
      const row = this.rowIndexById.get(rowId ?? "");
      const col = this.colIndexById.get(colId ?? "");
      if (row !== undefined && col !== undefined) cells.push({ row, col });
    }
    this.pendingFormatKeys.clear();
    if (cells.length > 0) this.emit({ type: "cells", cells });
  }

  dimensions(): GridDimensions {
    const rowHeights = getRowHeightsMap(this.doc, this.sheetId);
    const colWidths = getColWidthsMap(this.doc, this.sheetId);
    return {
      rowCount: this.rowIds.length,
      colCount: this.colIds.length,
      rowHeight: (i) => {
        const h = rowHeights.get(this.rowIds[i] ?? "");
        return typeof h === "number" ? h : DEFAULT_ROW_HEIGHT;
      },
      colWidth: (j) => {
        const w = colWidths.get(this.colIds[j] ?? "");
        return typeof w === "number" ? w : DEFAULT_COL_WIDTH;
      },
      colLabel: colIndexToLabel,
    };
  }

  rowIdAt(i: number): string | undefined {
    return this.rowIds[i];
  }

  colIdAt(j: number): string | undefined {
    return this.colIds[j];
  }

  rowIndexOf(id: string): number | undefined {
    return this.rowIndexById.get(id);
  }

  colIndexOf(id: string): number | undefined {
    return this.colIndexById.get(id);
  }

  getCell(coord: CellCoord): CellRenderData {
    const rowId = this.rowIds[coord.row];
    const colId = this.colIds[coord.col];
    if (rowId === undefined || colId === undefined) return { text: "" };
    const { text, error } = displayValue(this.engine.getValue(this.sheetId, coord.row, coord.col));
    const format = getFormatsMap(this.doc, this.sheetId).get(cellKey(rowId, colId));
    return {
      text,
      ...(format ? { format } : {}),
      ...(error ? { error } : {}),
    };
  }

  /** What the cell editor and formula bar show: formulas as A1 text. */
  getRawInput(coord: CellCoord): string {
    const rowId = this.rowIds[coord.row];
    const colId = this.colIds[coord.col];
    if (rowId === undefined || colId === undefined) return "";
    const data = getCellsMap(this.doc, this.sheetId).get(cellKey(rowId, colId));
    if (!data) return "";
    if (data.f !== undefined) {
      return decodeFormula(data.f, {
        sheetId: this.sheetId,
        lookup: (id) =>
          id === this.sheetId
            ? {
                rowIndex: (r) => this.rowIndexById.get(r),
                colIndex: (c) => this.colIndexById.get(c),
              }
            : lookupSheetIndex(this.doc, id),
        sheetPrefix: (id) => formatSheetPrefix(getSheetName(this.doc, id) ?? id),
      });
    }
    if (typeof data.v === "boolean") return data.v ? "TRUE" : "FALSE";
    if (typeof data.v === "string") return textAsInput(data.v);
    return data.v === undefined ? "" : String(data.v);
  }

  subscribe(listener: (event: ModelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  destroy(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    this.listeners.clear();
  }
}

// Text that would re-parse as something else ("007", "TRUE", "=x", "'a", "  ")
// gets Excel's leading apostrophe, so committing the editor unchanged keeps it text.
function textAsInput(text: string): string {
  const parsed = parseCellInput(text);
  return parsed.kind === "value" && parsed.value === text ? text : `'${text}`;
}
