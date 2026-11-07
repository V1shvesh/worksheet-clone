import type {
  CellCoord,
  CellRange,
  CellRenderData,
  GridDimensions,
  GridEvents,
  GridTarget,
  GridView,
  HeaderHit,
  KeyInfo,
  PointerInfo,
  Rect,
} from "../../port/types";

export interface FakeGridOptions {
  viewportWidth?: number;
  viewportHeight?: number;
  headerHeight?: number;
  rowHeaderWidth?: number;
}

// Handler sets are keyed by event name; `on`/`emit` restore the per-event types.
type Handlers = Map<keyof GridEvents, Set<unknown>>;

/** First index whose offset is > v (offsets are ascending). */
function upperBound(offsets: number[], v: number): number {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose offset is >= v. */
function lowerBound(offsets: number[], v: number): number {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const cellKey = (c: CellCoord): string => `${c.row}:${c.col}`;

const defaultPointer = (clientX = 0, clientY = 0): PointerInfo => ({
  clientX,
  clientY,
  button: 0,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
});

/**
 * In-memory GridView with deterministic geometry. The mount element is treated as
 * sitting at client (0,0). Nothing is painted; visible cells are cached from `getCell`
 * so tests can observe stale vs refreshed content.
 */
export class FakeGridView implements GridView {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly headerHeight: number;
  readonly rowHeaderWidth: number;

  /** Every refreshCells argument, in call order. */
  readonly refreshLog: (CellCoord[] | "all")[] = [];
  element: HTMLElement | null = null;
  focusCount = 0;

  private state: "new" | "mounted" | "destroyed" = "new";
  private dims: GridDimensions | null = null;
  private getCell: ((c: CellCoord) => CellRenderData) | null = null;
  private rowTops: number[] = [0];
  private colLefts: number[] = [0];
  private scrollX = 0;
  private scrollY = 0;
  private cache = new Map<string, CellRenderData>();
  private handlers: Handlers = new Map();

  constructor(opts: FakeGridOptions = {}) {
    this.viewportWidth = opts.viewportWidth ?? 800;
    this.viewportHeight = opts.viewportHeight ?? 600;
    this.headerHeight = opts.headerHeight ?? 24;
    this.rowHeaderWidth = opts.rowHeaderWidth ?? 48;
  }

  // ---- lifecycle ----

  mount(el: HTMLElement, dims: GridDimensions, getCell: (c: CellCoord) => CellRenderData): void {
    if (this.state === "mounted") throw new Error("FakeGridView: already mounted");
    if (this.state === "destroyed") throw new Error("FakeGridView: cannot mount after destroy");
    this.element = el;
    this.getCell = getCell;
    this.state = "mounted";
    this.applyDimensions(dims);
    this.scrollX = 0;
    this.scrollY = 0;
    this.renderVisible(true);
  }

  destroy(): void {
    this.assertMounted("destroy");
    this.state = "destroyed";
    this.cache.clear();
    this.handlers.clear();
    this.element = null;
  }

  // ---- rendering ----

  setDimensions(dims: GridDimensions): void {
    this.assertMounted("setDimensions");
    this.applyDimensions(dims);
    this.clampScroll();
    this.renderVisible(true);
  }

  refreshCells(cells: CellCoord[] | "all"): void {
    this.assertMounted("refreshCells");
    this.refreshLog.push(cells === "all" ? "all" : cells.map((c) => ({ ...c })));
    if (cells === "all") {
      this.renderVisible(true);
      return;
    }
    for (const c of cells) {
      if (this.getCellRect(c) !== null) this.cache.set(cellKey(c), this.read(c));
    }
  }

  // ---- geometry ----

  getCellRect(c: CellCoord): Rect | null {
    this.assertMounted("getCellRect");
    const dims = this.dims!;
    if (c.row < 0 || c.row >= dims.rowCount || c.col < 0 || c.col >= dims.colCount) return null;
    const x = this.rowHeaderWidth + this.colLefts[c.col]! - this.scrollX;
    const y = this.headerHeight + this.rowTops[c.row]! - this.scrollY;
    const width = dims.colWidth(c.col);
    const height = dims.rowHeight(c.row);
    const visible =
      x < this.viewportWidth &&
      x + width > this.rowHeaderWidth &&
      y < this.viewportHeight &&
      y + height > this.headerHeight;
    return visible ? { x, y, width, height } : null;
  }

  hitTest(clientX: number, clientY: number): CellCoord | HeaderHit | null {
    this.assertMounted("hitTest");
    const dims = this.dims!;
    if (
      clientX < 0 ||
      clientY < 0 ||
      clientX >= this.viewportWidth ||
      clientY >= this.viewportHeight
    )
      return null;
    const inRowHeader = clientX < this.rowHeaderWidth;
    const inColHeader = clientY < this.headerHeight;
    if (inRowHeader && inColHeader) return { kind: "corner" };

    const col = inRowHeader
      ? -1
      : this.indexAtContentX(clientX - this.rowHeaderWidth + this.scrollX);
    const row = inColHeader ? -1 : this.indexAtContentY(clientY - this.headerHeight + this.scrollY);
    if (!inRowHeader && (col < 0 || col >= dims.colCount)) return null;
    if (!inColHeader && (row < 0 || row >= dims.rowCount)) return null;
    if (inColHeader) return { kind: "colHeader", col };
    if (inRowHeader) return { kind: "rowHeader", row };
    return { row, col };
  }

  getVisibleRange(): CellRange {
    this.assertMounted("getVisibleRange");
    const dims = this.dims!;
    if (dims.rowCount === 0 || dims.colCount === 0) {
      return { start: { row: 0, col: 0 }, end: { row: -1, col: -1 } };
    }
    const bottom = this.scrollY + this.areaHeight;
    const right = this.scrollX + this.areaWidth;
    return {
      start: {
        row: Math.min(Math.max(0, upperBound(this.rowTops, this.scrollY) - 1), dims.rowCount - 1),
        col: Math.min(Math.max(0, upperBound(this.colLefts, this.scrollX) - 1), dims.colCount - 1),
      },
      end: {
        row: Math.min(lowerBound(this.rowTops, bottom) - 1, dims.rowCount - 1),
        col: Math.min(lowerBound(this.colLefts, right) - 1, dims.colCount - 1),
      },
    };
  }

  scrollIntoView(c: CellCoord): void {
    this.assertMounted("scrollIntoView");
    const dims = this.dims!;
    if (c.row < 0 || c.row >= dims.rowCount || c.col < 0 || c.col >= dims.colCount) {
      throw new RangeError(`FakeGridView: cell ${cellKey(c)} is out of range`);
    }
    this.scrollTo(
      this.minimalScroll(
        this.scrollX,
        this.colLefts[c.col]!,
        this.colLefts[c.col + 1]!,
        this.areaWidth,
      ),
      this.minimalScroll(
        this.scrollY,
        this.rowTops[c.row]!,
        this.rowTops[c.row + 1]!,
        this.areaHeight,
      ),
    );
  }

  focus(): void {
    this.assertMounted("focus");
    this.focusCount++;
  }

  on<E extends keyof GridEvents>(event: E, handler: GridEvents[E]): () => void {
    let set = this.handlers.get(event) as Set<GridEvents[E]> | undefined;
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  // ---- test helpers ----

  /** Scroll offsets are clamped to the content size; emits `scroll` only on change. */
  scrollTo(x: number, y: number): void {
    this.assertMounted("scrollTo");
    const prevX = this.scrollX;
    const prevY = this.scrollY;
    this.scrollX = x;
    this.scrollY = y;
    this.clampScroll();
    if (this.scrollX === prevX && this.scrollY === prevY) return;
    this.renderVisible(false);
    this.emit("scroll", this.getVisibleRange());
  }

  get scrollOffset(): { x: number; y: number } {
    return { x: this.scrollX, y: this.scrollY };
  }

  /** Text currently painted for a cell, or null if the cell is not rendered. */
  displayedText(c: CellCoord): string | null {
    this.assertMounted("displayedText");
    return this.cache.get(cellKey(c))?.text ?? null;
  }

  displayedData(c: CellCoord): CellRenderData | null {
    this.assertMounted("displayedData");
    return this.cache.get(cellKey(c)) ?? null;
  }

  pointerDown(target: GridTarget, e: Partial<PointerInfo> = {}): void {
    this.emit("pointerDown", target, { ...defaultPointer(), ...e });
  }

  pointerMove(target: GridTarget, e: Partial<PointerInfo> = {}): void {
    this.emit("pointerMove", target, { ...defaultPointer(), ...e });
  }

  pointerUp(target: GridTarget | null, e: Partial<PointerInfo> = {}): void {
    this.emit("pointerUp", target, { ...defaultPointer(), ...e });
  }

  doubleClick(target: GridTarget): void {
    this.emit("doubleClick", target);
  }

  contextMenu(target: GridTarget, clientX = 0, clientY = 0): void {
    this.emit("contextMenu", target, clientX, clientY);
  }

  keyDown(e: Partial<KeyInfo> & { key: string }): void {
    this.emit("keyDown", {
      code: e.key,
      shiftKey: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      ...e,
    });
  }

  columnResized(col: number, width: number): void {
    this.emit("columnResized", col, width);
  }

  rowResized(row: number, height: number): void {
    this.emit("rowResized", row, height);
  }

  columnMoveRequested(from: number, to: number): void {
    this.emit("columnMoveRequested", from, to);
  }

  rowMoveRequested(from: number, to: number): void {
    this.emit("rowMoveRequested", from, to);
  }

  // ---- internals ----

  private get areaWidth(): number {
    return Math.max(0, this.viewportWidth - this.rowHeaderWidth);
  }

  private get areaHeight(): number {
    return Math.max(0, this.viewportHeight - this.headerHeight);
  }

  private assertMounted(method: string): void {
    if (this.state === "new") throw new Error(`FakeGridView.${method}() called before mount()`);
    if (this.state === "destroyed") {
      throw new Error(`FakeGridView.${method}() called after destroy()`);
    }
  }

  private emit<E extends keyof GridEvents>(event: E, ...args: Parameters<GridEvents[E]>): void {
    const set = this.handlers.get(event) as Set<GridEvents[E]> | undefined;
    if (!set) return;
    for (const h of [...set]) (h as (...a: Parameters<GridEvents[E]>) => void)(...args);
  }

  private read(c: CellCoord): CellRenderData {
    return this.getCell!(c);
  }

  private applyDimensions(dims: GridDimensions): void {
    this.dims = dims;
    this.rowTops = [0];
    for (let r = 0; r < dims.rowCount; r++) {
      this.rowTops.push(this.rowTops[r]! + dims.rowHeight(r));
    }
    this.colLefts = [0];
    for (let c = 0; c < dims.colCount; c++) {
      this.colLefts.push(this.colLefts[c]! + dims.colWidth(c));
    }
  }

  private clampScroll(): void {
    const maxX = Math.max(0, this.colLefts[this.colLefts.length - 1]! - this.areaWidth);
    const maxY = Math.max(0, this.rowTops[this.rowTops.length - 1]! - this.areaHeight);
    this.scrollX = Math.min(Math.max(0, this.scrollX), maxX);
    this.scrollY = Math.min(Math.max(0, this.scrollY), maxY);
  }

  /** Re-reads every visible cell (fresh=true) or only newly visible ones, dropping the rest. */
  private renderVisible(fresh: boolean): void {
    const next = new Map<string, CellRenderData>();
    const dims = this.dims!;
    if (dims.rowCount > 0 && dims.colCount > 0) {
      const { start, end } = this.getVisibleRange();
      for (let row = start.row; row <= end.row; row++) {
        for (let col = start.col; col <= end.col; col++) {
          const key = cellKey({ row, col });
          const existing = fresh ? undefined : this.cache.get(key);
          next.set(key, existing ?? this.read({ row, col }));
        }
      }
    }
    this.cache = next;
  }

  private indexAtContentX(x: number): number {
    return upperBound(this.colLefts, x) - 1;
  }

  private indexAtContentY(y: number): number {
    return upperBound(this.rowTops, y) - 1;
  }

  private minimalScroll(current: number, start: number, end: number, size: number): number {
    if (end > current + size) current = end - size;
    if (start < current) current = start;
    return current;
  }
}
