import type { CellFormat } from "@worksheet-clone/shared";

// Coordinates are visual indices (screen position), never row/col ids (ADR-0001).
export interface CellCoord {
  row: number;
  col: number;
}

/** Inclusive and normalized: start <= end on both axes. */
export interface CellRange {
  start: CellCoord;
  end: CellCoord;
}

/** Relative to the grid viewport's top-left corner. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridDimensions {
  rowCount: number;
  colCount: number;
  rowHeight(row: number): number;
  colWidth(col: number): number;
  colLabel(col: number): string; // "A", "B", …
}

export interface CellRenderData {
  text: string;
  format?: CellFormat;
  error?: boolean;
}

export type HeaderHit =
  { kind: "rowHeader"; row: number } | { kind: "colHeader"; col: number } | { kind: "corner" };

export type GridTarget = CellCoord | HeaderHit;

/** Plain pointer data; never a DOM or grid-library event. */
export interface PointerInfo {
  clientX: number;
  clientY: number;
  button: number;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** Plain keyboard data; never a DOM or grid-library event. */
export interface KeyInfo {
  key: string;
  code: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export interface GridEvents {
  pointerDown(target: CellCoord | HeaderHit, e: PointerInfo): void;
  pointerMove(target: CellCoord | HeaderHit, e: PointerInfo): void;
  pointerUp(target: CellCoord | HeaderHit | null, e: PointerInfo): void;
  doubleClick(target: CellCoord | HeaderHit): void;
  contextMenu(target: CellCoord | HeaderHit, clientX: number, clientY: number): void;
  keyDown(e: KeyInfo): void; // adapter suppresses its own key handling
  scroll(visible: CellRange): void;
  /** Emitted once, when the user releases a column-resize drag (never per pixel). */
  columnResized(col: number, width: number): void;
  /**
   * Reserved: AG Grid has no row-resize gesture, so no adapter emits this today. Row resizing is
   * an overlay handle that calls the interaction controller directly (see `overlay/`).
   */
  rowResized(row: number, height: number): void;
  /**
   * Reserved for reordering (deferred past M7): NOT emitted by any adapter today. AG Grid's
   * column moving is switched off, so a header drag only selects columns.
   */
  columnMoveRequested(from: number, to: number): void;
  /** Reserved, see `columnMoveRequested`. */
  rowMoveRequested(from: number, to: number): void;
}

export interface GridView {
  mount(el: HTMLElement, dims: GridDimensions, getCell: (c: CellCoord) => CellRenderData): void;
  destroy(): void;

  // rendering
  setDimensions(dims: GridDimensions): void; // after structure ops
  refreshCells(cells: CellCoord[] | "all"): void; // after value/format changes

  // geometry (powers overlays, fill handle, floating editor)
  getCellRect(c: CellCoord): Rect | null; // null = not rendered
  hitTest(clientX: number, clientY: number): CellCoord | HeaderHit | null;
  getVisibleRange(): CellRange;
  scrollIntoView(c: CellCoord): void;

  // focus
  focus(): void;

  on<E extends keyof GridEvents>(event: E, handler: GridEvents[E]): () => void;
}

export function isHeaderHit(t: GridTarget | null): t is HeaderHit {
  return t !== null && "kind" in t;
}

export function coordsEqual(a: CellCoord, b: CellCoord): boolean {
  return a.row === b.row && a.col === b.col;
}

export function targetsEqual(a: GridTarget | null, b: GridTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (isHeaderHit(a) || isHeaderHit(b)) {
    if (!isHeaderHit(a) || !isHeaderHit(b) || a.kind !== b.kind) return false;
    if (a.kind === "rowHeader" && b.kind === "rowHeader") return a.row === b.row;
    if (a.kind === "colHeader" && b.kind === "colHeader") return a.col === b.col;
    return true;
  }
  return coordsEqual(a, b);
}

export function normalizeRange(a: CellCoord, b: CellCoord): CellRange {
  return {
    start: { row: Math.min(a.row, b.row), col: Math.min(a.col, b.col) },
    end: { row: Math.max(a.row, b.row), col: Math.max(a.col, b.col) },
  };
}

export function rangeContains(range: CellRange, c: CellCoord): boolean {
  return (
    c.row >= range.start.row &&
    c.row <= range.end.row &&
    c.col >= range.start.col &&
    c.col <= range.end.col
  );
}
