import {
  CellApiModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  ColumnApiModule,
  createGrid,
  RenderApiModule,
  RowApiModule,
  ScrollApiModule,
  themeQuartz,
  type ColDef,
  type GridApi,
  type GridOptions,
  type IHeaderComp,
  type IHeaderParams,
  type ICellRendererComp,
  type ICellRendererParams,
} from "ag-grid-community";
import type {
  CellCoord,
  CellRange,
  CellRenderData,
  GridDimensions,
  GridEvents,
  GridView,
  HeaderHit,
  KeyInfo,
  PointerInfo,
  Rect,
} from "../../port/types";

// Smallest module set that renders, scrolls and resizes columns. Anything else
// (editing, selection, clipboard, filtering, sorting...) is ours, not AG Grid's.
const MODULES = [
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  ColumnApiModule,
  RowApiModule,
  CellApiModule,
  RenderApiModule,
  ScrollApiModule,
];

export interface AgGridViewOptions {
  headerHeight?: number;
  rowHeaderWidth?: number;
}

const ROW_HEADER_ID = "rowHeader";
const colId = (col: number): string => `c${col}`;
const colFromId = (id: string): number => Number(id.slice(1));

interface RowDatum {
  i: number;
}

// Rows are emitted as plain objects so AG Grid never sees ids, Yjs or HyperFormula.
type Handlers = Map<keyof GridEvents, Set<unknown>>;

/** Keys the browser would otherwise use to scroll/navigate; we forward them and swallow the default. */
const ALWAYS_PREVENT = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);
// Command chords the app handles itself (undo/redo and, later, formatting); the browser must not.
const HANDLED_COMMAND_KEYS = new Set(["z", "y", "b", "i", "u"]);
const PREVENT_WITHOUT_COMMAND = new Set(["Tab", "Enter", " ", "Escape", "Delete", "Backspace"]);

class CellPainter implements ICellRendererComp<RowDatum> {
  private el = document.createElement("div");

  constructor() {
    this.el.style.cssText =
      "width:100%;height:100%;box-sizing:border-box;padding:0 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
  }

  init(params: ICellRendererParams<RowDatum, CellRenderData>): void {
    const cell = params.eGridCell;
    const col = colFromId(params.column!.getColId());
    cell.setAttribute("data-row", String(params.data!.i));
    cell.setAttribute("data-col", String(col));
    // AG Grid already gives its cell element role="gridcell"; keep it the only one.
    cell.setAttribute("role", "gridcell");
    this.paint(params.value);
  }

  getGui(): HTMLElement {
    return this.el;
  }

  // Returning false makes AG Grid destroy and re-create the renderer on refresh.
  refresh(): boolean {
    return false;
  }

  private paint(data: CellRenderData | null | undefined): void {
    const el = this.el;
    el.textContent = data?.text ?? "";
    const f = data?.format;
    el.style.background = f?.bg ?? "";
    el.style.fontWeight = f?.b ? "bold" : "";
    el.style.fontStyle = f?.i ? "italic" : "";
    el.style.textDecoration = f?.u ? "underline" : "";
    el.style.color = data?.error ? "#c0392b" : "";
  }
}

class RowHeaderPainter implements ICellRendererComp<RowDatum> {
  private el = document.createElement("div");

  init(params: ICellRendererParams<RowDatum, number>): void {
    params.eGridCell.setAttribute("data-row-header", String(params.data!.i));
    params.eGridCell.setAttribute("role", "rowheader");
    this.el.textContent = String(params.value ?? "");
    this.el.style.cssText = "width:100%;text-align:center;color:#666";
  }

  getGui(): HTMLElement {
    return this.el;
  }

  refresh(): boolean {
    return false;
  }
}

class ColumnHeaderPainter implements IHeaderComp {
  private el = document.createElement("div");

  init(params: IHeaderParams): void {
    const id = params.column.getColId();
    if (id === ROW_HEADER_ID) this.el.setAttribute("data-corner", "");
    else this.el.setAttribute("data-col-header", String(colFromId(id)));
    this.el.textContent = params.displayName;
    this.el.style.cssText = "width:100%;text-align:center;font-weight:600";
  }

  getGui(): HTMLElement {
    return this.el;
  }

  refresh(): boolean {
    return false;
  }
}

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

/**
 * GridView over AG Grid Community, used only to paint and scroll (ADR-0001).
 * Rect geometry is relative to the top-left of the element passed to `mount`.
 * AG Grid has no row-resize gesture, so `rowResized` is never emitted.
 */
export class AgGridView implements GridView {
  private readonly headerHeight: number;
  private readonly rowHeaderWidth: number;

  private state: "new" | "mounted" | "destroyed" = "new";
  private root: HTMLElement | null = null;
  private api: GridApi<RowDatum> | null = null;
  private dims: GridDimensions | null = null;
  private getCell: ((c: CellCoord) => CellRenderData) | null = null;
  private rowTops: number[] = [0];
  private handlers: Handlers = new Map();
  private cleanups: (() => void)[] = [];
  private pressed = false;

  constructor(opts: AgGridViewOptions = {}) {
    this.headerHeight = opts.headerHeight ?? 24;
    this.rowHeaderWidth = opts.rowHeaderWidth ?? 48;
  }

  // ---- lifecycle ----

  mount(el: HTMLElement, dims: GridDimensions, getCell: (c: CellCoord) => CellRenderData): void {
    if (this.state === "mounted") throw new Error("AgGridView: already mounted");
    if (this.state === "destroyed") throw new Error("AgGridView: cannot mount after destroy");
    this.dims = dims;
    this.getCell = getCell;
    this.computeRowTops();

    const root = document.createElement("div");
    root.tabIndex = 0;
    root.style.cssText = "width:100%;height:100%;outline:none;user-select:none";
    el.appendChild(root);
    this.root = root;

    const options: GridOptions<RowDatum> = {
      theme: themeQuartz.withParams({ cellHorizontalPadding: 0 }),
      columnDefs: this.buildColumnDefs(),
      rowData: this.buildRowData(),
      getRowId: (p) => String(p.data.i),
      getRowHeight: (p) => this.dims!.rowHeight(p.data!.i),
      headerHeight: this.headerHeight,
      readOnlyEdit: true,
      suppressCellFocus: true,
      suppressHeaderFocus: true,
      // Reordering is deferred (M7); a header drag must not even animate a move.
      suppressMovableColumns: true,
      suppressDragLeaveHidesColumns: true,
      suppressRowHoverHighlight: true,
      suppressAnimationFrame: true,
      animateRows: false,
      onBodyScroll: () => this.emit("scroll", this.getVisibleRange()),
      onColumnResized: (e) => {
        if (!e.finished || e.source !== "uiColumnResized" || !e.column) return;
        const id = e.column.getColId();
        if (id === ROW_HEADER_ID) return;
        this.emit("columnResized", colFromId(id), e.column.getActualWidth());
      },
    };
    this.api = createGrid<RowDatum>(root, options, { modules: MODULES });
    this.state = "mounted";
    this.applyRowHeights();
    this.attachListeners(root);
  }

  destroy(): void {
    this.assertMounted("destroy");
    this.state = "destroyed";
    for (const off of this.cleanups) off();
    this.cleanups = [];
    this.api!.destroy();
    this.root!.remove();
    this.api = null;
    this.root = null;
    this.handlers.clear();
  }

  // ---- rendering ----

  setDimensions(dims: GridDimensions): void {
    this.assertMounted("setDimensions");
    this.dims = dims;
    this.computeRowTops();
    const api = this.api!;
    api.updateGridOptions({ columnDefs: this.buildColumnDefs(), rowData: this.buildRowData() });
    // A user resize that the model declined must not stick, so re-apply widths and order.
    api.applyColumnState({
      state: [
        { colId: ROW_HEADER_ID, width: this.rowHeaderWidth },
        ...Array.from({ length: dims.colCount }, (_, j) => ({
          colId: colId(j),
          width: dims.colWidth(j),
        })),
      ],
      applyOrder: true,
    });
    this.applyRowHeights();
  }

  refreshCells(cells: CellCoord[] | "all"): void {
    this.assertMounted("refreshCells");
    const api = this.api!;
    if (cells === "all") {
      api.refreshCells({ force: true });
      return;
    }
    const dims = this.dims!;
    const rowNodes = new Set<NonNullable<ReturnType<GridApi<RowDatum>["getRowNode"]>>>();
    const columns = new Set<string>();
    for (const c of cells) {
      if (c.row < 0 || c.row >= dims.rowCount || c.col < 0 || c.col >= dims.colCount) continue;
      const node = api.getRowNode(String(c.row));
      if (node) rowNodes.add(node);
      columns.add(colId(c.col));
    }
    if (rowNodes.size === 0) return;
    // Rows x columns is a superset of `cells`; refreshing a few extra visible cells is harmless
    // because their values come from the same source of truth.
    api.refreshCells({ rowNodes: [...rowNodes], columns: [...columns], force: true });
  }

  // ---- geometry ----

  getCellRect(c: CellCoord): Rect | null {
    this.assertMounted("getCellRect");
    const el = this.root!.querySelector<HTMLElement>(`[data-row="${c.row}"][data-col="${c.col}"]`);
    if (!el) return null;
    const origin = this.root!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // AG Grid's cell is 1px shorter than its row (row border), so take the height from the row.
    const height = el.closest(".ag-row")?.getBoundingClientRect().height ?? r.height;
    const area = this.dataArea();
    const x = r.left - origin.left;
    const y = r.top - origin.top;
    const visible =
      x < area.right && x + r.width > area.left && y < area.bottom && y + height > area.top;
    return visible ? { x, y, width: r.width, height } : null;
  }

  getRowHeaderRect(row: number): Rect | null {
    this.assertMounted("getRowHeaderRect");
    const el = this.root!.querySelector<HTMLElement>(`[data-row-header="${row}"]`);
    if (!el) return null;
    const origin = this.root!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const height = el.closest(".ag-row")?.getBoundingClientRect().height ?? r.height;
    const area = this.dataArea();
    const y = r.top - origin.top;
    if (!(y < area.bottom && y + height > area.top)) return null;
    return { x: r.left - origin.left, y, width: r.width, height };
  }

  hitTest(clientX: number, clientY: number): CellCoord | HeaderHit | null {
    this.assertMounted("hitTest");
    const bounds = this.root!.getBoundingClientRect();
    if (
      clientX < bounds.left ||
      clientY < bounds.top ||
      clientX >= bounds.right ||
      clientY >= bounds.bottom
    ) {
      return null;
    }
    const hit = document.elementFromPoint(clientX, clientY);
    if (!hit || !this.root!.contains(hit)) return null;

    const cell = hit.closest<HTMLElement>("[data-row][data-col]");
    if (cell) return { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
    const rowHeader = hit.closest<HTMLElement>("[data-row-header]");
    if (rowHeader) return { kind: "rowHeader", row: Number(rowHeader.dataset.rowHeader) };
    if (hit.closest(".ag-header")) {
      // The header row has borders and padding between cells; resolve those by x position.
      for (const header of this.root!.querySelectorAll<HTMLElement>(".ag-header-cell")) {
        const r = header.getBoundingClientRect();
        if (clientX < r.left || clientX > r.right) continue;
        const id = header.getAttribute("col-id");
        if (id === ROW_HEADER_ID) return { kind: "corner" };
        if (id) return { kind: "colHeader", col: colFromId(id) };
      }
    }
    return null;
  }

  getVisibleRange(): CellRange {
    this.assertMounted("getVisibleRange");
    const dims = this.dims!;
    if (dims.rowCount === 0 || dims.colCount === 0) {
      return { start: { row: 0, col: 0 }, end: { row: -1, col: -1 } };
    }
    const api = this.api!;
    const v = api.getVerticalPixelRange();
    const h = api.getHorizontalPixelRange();
    const colLefts = this.colLefts();
    // AG Grid's pixel ranges run under the scrollbars; trim them to the area getCellRect considers visible.
    const area = this.dataArea();
    const bottom = v.top + (area.bottom - area.top);
    const right = h.left + (area.right - area.left);
    return {
      start: {
        row: Math.min(Math.max(0, upperBound(this.rowTops, v.top) - 1), dims.rowCount - 1),
        col: Math.min(Math.max(0, upperBound(colLefts, h.left) - 1), dims.colCount - 1),
      },
      end: {
        row: Math.min(lowerBound(this.rowTops, bottom) - 1, dims.rowCount - 1),
        col: Math.min(lowerBound(colLefts, right) - 1, dims.colCount - 1),
      },
    };
  }

  scrollIntoView(c: CellCoord): void {
    this.assertMounted("scrollIntoView");
    const dims = this.dims!;
    if (c.row < 0 || c.row >= dims.rowCount || c.col < 0 || c.col >= dims.colCount) {
      throw new RangeError(`AgGridView: cell ${c.row}:${c.col} is out of range`);
    }
    this.api!.ensureIndexVisible(c.row);
    this.api!.ensureColumnVisible(colId(c.col));
  }

  focus(): void {
    this.assertMounted("focus");
    this.root!.focus({ preventScroll: true });
  }

  on<E extends keyof GridEvents>(event: E, handler: GridEvents[E]): () => void {
    let set = this.handlers.get(event) as Set<GridEvents[E]> | undefined;
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  // ---- internals ----

  private assertMounted(method: string): void {
    if (this.state === "new") throw new Error(`AgGridView.${method}() called before mount()`);
    if (this.state === "destroyed") {
      throw new Error(`AgGridView.${method}() called after destroy()`);
    }
  }

  private emit<E extends keyof GridEvents>(event: E, ...args: Parameters<GridEvents[E]>): void {
    const set = this.handlers.get(event) as Set<GridEvents[E]> | undefined;
    if (!set) return;
    for (const h of [...set]) (h as (...a: Parameters<GridEvents[E]>) => void)(...args);
  }

  private computeRowTops(): void {
    const dims = this.dims!;
    this.rowTops = [0];
    for (let r = 0; r < dims.rowCount; r++) {
      this.rowTops.push(this.rowTops[r]! + dims.rowHeight(r));
    }
  }

  /**
   * With a `getRowHeight` callback AG Grid only measures rows near the viewport and estimates the
   * rest at the default height, which would make scroll positions disagree with `GridDimensions`.
   * Setting every node's height explicitly marks them as measured.
   */
  private applyRowHeights(): void {
    const dims = this.dims!;
    this.api!.forEachNode((node) => node.setRowHeight(dims.rowHeight(node.data!.i)));
    this.api!.onRowHeightChanged();
  }

  private buildRowData(): RowDatum[] {
    return Array.from({ length: this.dims!.rowCount }, (_, i) => ({ i }));
  }

  private buildColumnDefs(): ColDef<RowDatum>[] {
    const dims = this.dims!;
    const getCell = (c: CellCoord) => this.getCell!(c);
    const rowHeader: ColDef<RowDatum> = {
      colId: ROW_HEADER_ID,
      headerName: "",
      pinned: "left",
      lockPosition: "left",
      suppressMovable: true,
      resizable: false,
      width: this.rowHeaderWidth,
      valueGetter: (p) => p.data!.i + 1,
      cellRenderer: RowHeaderPainter,
      headerComponent: ColumnHeaderPainter,
      suppressKeyboardEvent: () => true,
      suppressHeaderKeyboardEvent: () => true,
    };
    const cols = Array.from({ length: dims.colCount }, (_, j): ColDef<RowDatum> => ({
      colId: colId(j),
      headerName: dims.colLabel(j),
      width: dims.colWidth(j),
      resizable: true,
      editable: false,
      sortable: false,
      suppressMovable: true,
      valueGetter: (p) => getCell({ row: p.data!.i, col: j }),
      cellRenderer: CellPainter,
      headerComponent: ColumnHeaderPainter,
      suppressKeyboardEvent: () => true,
      suppressHeaderKeyboardEvent: () => true,
    }));
    return [rowHeader, ...cols];
  }

  /** Left offsets (content coordinates) of every data column, from AG Grid's live widths. */
  private colLefts(): number[] {
    const lefts = [0];
    for (let j = 0; j < this.dims!.colCount; j++) {
      const width = this.api!.getColumn(colId(j))?.getActualWidth() ?? this.dims!.colWidth(j);
      lefts.push(lefts[j]! + width);
    }
    return lefts;
  }

  /** The scrolling data area (excludes headers, the pinned column and scrollbars), relative to root. */
  private dataArea(): { left: number; top: number; right: number; bottom: number } {
    const root = this.root!;
    const origin = root.getBoundingClientRect();
    const rect = (selector: string) => {
      const el = root.querySelector<HTMLElement>(selector);
      return el && el.offsetWidth > 0 && el.offsetHeight > 0 ? el.getBoundingClientRect() : null;
    };
    const pinnedHeader = rect(`.ag-header-cell[col-id="${ROW_HEADER_ID}"]`);
    const header = rect(".ag-header");
    const vScroll = rect(".ag-body-vertical-scroll");
    const hScroll = rect(".ag-body-horizontal-scroll");
    return {
      left: (pinnedHeader?.right ?? origin.left + this.rowHeaderWidth) - origin.left,
      top: (header?.bottom ?? origin.top + this.headerHeight) - origin.top,
      right: (vScroll?.left ?? origin.right) - origin.left,
      bottom: (hScroll?.top ?? origin.bottom) - origin.top,
    };
  }

  private attachListeners(root: HTMLElement): void {
    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Document,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ) => {
      target.addEventListener(type, fn as EventListener);
      this.cleanups.push(() => target.removeEventListener(type, fn as EventListener));
    };

    const onMove = (e: PointerEvent) => {
      const target = this.hitTest(e.clientX, e.clientY);
      if (target) this.emit("pointerMove", target, toPointerInfo(e));
    };
    const onUp = (e: PointerEvent) => {
      if (!this.pressed) return;
      this.pressed = false;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      this.emit("pointerUp", this.hitTest(e.clientX, e.clientY), toPointerInfo(e));
    };
    this.cleanups.push(() => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    });

    listen(root, "pointerdown", (e) => {
      // Column resize handles are AG Grid's gesture, not a selection.
      if ((e.target as Element).closest(".ag-header-cell-resize")) return;
      const target = this.hitTest(e.clientX, e.clientY);
      if (!target) return;
      this.pressed = true;
      // Moves are only reported while a button is down, including outside the grid (drag selection).
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
      this.emit("pointerDown", target, toPointerInfo(e));
    });

    // A click's default action focuses AG Grid's row element (role="row"), which then draws its
    // own focus ring across the whole row. Keep DOM focus on our container instead.
    listen(root, "focusin", (e) => {
      if (e.target !== root) root.focus({ preventScroll: true });
    });

    listen(root, "dblclick", (e) => {
      if ((e.target as Element).closest(".ag-header-cell-resize")) return;
      const target = this.hitTest(e.clientX, e.clientY);
      if (target) this.emit("doubleClick", target);
    });

    listen(root, "contextmenu", (e) => {
      e.preventDefault();
      const target = this.hitTest(e.clientX, e.clientY);
      if (target) this.emit("contextMenu", target, e.clientX, e.clientY);
    });

    listen(root, "keydown", (e) => {
      const command = e.metaKey || e.ctrlKey;
      // A typed character starts our floating editor, which takes focus before the keypress
      // lands; without this the character would be inserted into it a second time (AltGr arrives
      // as Ctrl+Alt and still types).
      const typed =
        !e.metaKey && !(e.ctrlKey && !e.altKey) && !e.isComposing && [...e.key].length === 1;
      const handledChord = command && !e.altKey && HANDLED_COMMAND_KEYS.has(e.key.toLowerCase());
      if (
        ALWAYS_PREVENT.has(e.key) ||
        typed ||
        handledChord ||
        (!command && PREVENT_WITHOUT_COMMAND.has(e.key))
      ) {
        e.preventDefault();
      }
      const info: KeyInfo = {
        key: e.key,
        code: e.code,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
      };
      this.emit("keyDown", info);
    });
  }
}

function toPointerInfo(e: PointerEvent): PointerInfo {
  return {
    clientX: e.clientX,
    clientY: e.clientY,
    button: e.button,
    shiftKey: e.shiftKey,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
  };
}
