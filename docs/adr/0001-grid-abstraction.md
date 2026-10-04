# ADR-0001: AG Grid Community behind a grid port

- Status: Accepted
- Date: 2026-10-04

## Context

We want spreadsheet interactions (range selection, fill handle, clipboard ranges, header context menus). AG Grid ships these only in Enterprise ($999/dev). Alternatives (Glide Data Grid, RevoGrid, Handsontable, AG Grid Enterprise) may be worth switching to later. Switching must be cheap.

In our architecture the grid is already only a view: Yjs is the model and HyperFormula computes values. So the lock-in risk lives in two places: rendering/event APIs, and any interaction behavior we let the grid own.

## Decision

1. **Use AG Grid Community as a "dumb painter".** It provides virtualized rendering of cells and headers, scrolling, column/row sizing gestures and nothing else. It never owns data, selection, editing state, undo or keyboard semantics.
2. **We own all spreadsheet behavior** in grid-agnostic TypeScript: selection model, keyboard map, fill handle, clipboard, cell editor, context menus, overlays.
3. **A single port interface (`GridView`)** separates the two. Exactly one adapter implements it today: `adapters/ag-grid`.
4. **Enforced by tooling:** ESLint `no-restricted-imports` forbids `ag-grid-*` imports outside `apps/web/src/features/grid/adapters/ag-grid/**`.

## Layers

```
features/grid/
  model/         SheetViewModel: Yjs + HyperFormula → render data (display text, format, per-cell change events)
  interaction/   pure TS state machines: selection, keyboard, fill, clipboard, editing; emits Commands
  commands/      Command → one Yjs transaction (setCells, fillRange, pasteRange, clearRange, insertRows, moveCols…)
  port/          GridView interface + GridEvents + shared types (CellCoord, CellRange, Rect)
  overlay/       React: selection rectangles, fill handle, floating editor, remote cursors, context menu
  adapters/
    ag-grid/     the ONLY code that imports ag-grid-*
    fake/        in-memory adapter for unit tests (deterministic geometry)
  GridContainer.tsx   wires model + interaction + overlay + chosen adapter
```

Data flow: `adapter event → interaction → Command → Yjs transaction → SheetViewModel change → adapter.refreshCells + overlay re-render`.

## The port

Coordinates crossing the port are **visual indices** (row/col position on screen). The adapter never sees row/col ids, Yjs or HyperFormula. `SheetViewModel` translates index ⇄ id.

```ts
export interface CellCoord {
  row: number;
  col: number;
} // visual indices
export interface CellRange {
  start: CellCoord;
  end: CellCoord;
} // inclusive, normalized
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
} // relative to grid viewport

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

export type HeaderHit =
  { kind: "rowHeader"; row: number } | { kind: "colHeader"; col: number } | { kind: "corner" };

export interface GridEvents {
  pointerDown(target: CellCoord | HeaderHit, e: PointerInfo): void;
  pointerMove(target: CellCoord | HeaderHit, e: PointerInfo): void;
  pointerUp(target: CellCoord | HeaderHit | null, e: PointerInfo): void;
  doubleClick(target: CellCoord | HeaderHit): void;
  contextMenu(target: CellCoord | HeaderHit, clientX: number, clientY: number): void;
  keyDown(e: KeyInfo): void; // adapter suppresses its own key handling
  scroll(visible: CellRange): void;
  columnResized(col: number, width: number): void;
  rowResized(row: number, height: number): void;
  columnMoveRequested(from: number, to: number): void; // adapter reverts its own move; model decides
  rowMoveRequested(from: number, to: number): void;
}
```

`PointerInfo` / `KeyInfo` are plain objects (`shiftKey`, `metaKey`, `key`, `clientX`…), never DOM or AG Grid event types.

## How AG Grid Community is configured inside the adapter

- `rowData` = array of visual row indices; `getRowId` = index; columns generated from `GridDimensions`. Values come from `getCell` via a `valueGetter`; one shared cell renderer paints `CellRenderData`.
- `readOnlyEdit: true` and no AG Grid editors (`editable: false`); editing is our floating editor in `overlay/`.
- `suppressKeyboardEvent` returns true for everything; keys are forwarded as `keyDown`.
- Built-in column moving is allowed only to capture the gesture: on `columnMoved` the adapter emits `columnMoveRequested` and restores its column order; the order changes when the model re-sends dimensions.
- Row index column = pinned-left column painted from `GridDimensions`.
- Updates use `api.refreshCells({ rowNodes, columns })` for targeted repaints.

## Portability guarantees

- **Port contract tests** (`port/contract.test.ts`): a shared suite run against every adapter (fake in Vitest/jsdom; AG Grid in Playwright component tests) — geometry consistency, `hitTest(getCellRect(c)) === c`, refresh semantics, event mapping.
- **E2E tests never use grid-library selectors.** The shared cell renderer sets `data-row`, `data-col` and `role="gridcell"`; overlays have `data-testid`s. Playwright specs go through a `GridPage` page object; only it knows DOM details.
- Everything above `port/` is tested with the `fake` adapter, so most grid tests don't depend on AG Grid at all.

## Consequences

- Positive: switching grid = writing one adapter + passing contract tests. Interaction features (fill, clipboard, range select) are ours and survive any switch. Testing is mostly pure TS.
- Negative: we build range selection, fill handle, clipboard, context menu and editor ourselves (budgeted in M4/M6). Overlays must stay aligned with the grid's scrolling and pinned columns, which is the trickiest part; `getCellRect` + `scroll` events are the mechanism.
- Escape hatch: if overlay alignment or performance becomes a real problem, the fallback is AG Grid Enterprise (or another grid) via a new adapter, without touching `interaction/`, `commands/` or `model/`.
