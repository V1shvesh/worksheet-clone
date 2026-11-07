// Runner-agnostic: no test-framework imports, so the same cases run under Vitest (fake
// adapter) and Playwright component tests (AG Grid adapter).
import {
  coordsEqual,
  isHeaderHit,
  rangeContains,
  targetsEqual,
  type CellCoord,
  type CellRenderData,
  type GridDimensions,
  type GridTarget,
  type GridView,
  type KeyInfo,
  type PointerInfo,
} from "./types";

type MaybePromise<T> = T | Promise<T>;

export interface ContractGridOptions {
  dims: GridDimensions;
  getCell: (c: CellCoord) => CellRenderData;
  viewport: { width: number; height: number };
}

/** What an adapter's test driver must provide. The grid starts scrolled to (0,0). */
export interface ContractGrid {
  view: GridView;
  /** Text currently painted for the cell, or null if it is not rendered. */
  displayedText(c: CellCoord): MaybePromise<string | null>;
  /** Scroll to pixel offsets (clamped by the grid) the way a user scroll would. */
  scrollTo(x: number, y: number): MaybePromise<void>;
  /** Primary-button press + release on the centre of a visible cell. */
  click(c: CellCoord): MaybePromise<void>;
  /** Press and release a key on the focused grid. */
  pressKey(key: string): MaybePromise<void>;
  /** Convert a viewport-relative point (as in Rect) to client coordinates. */
  viewportToClient(x: number, y: number): { clientX: number; clientY: number };
  /** Tear down the driver; must be safe to call after `view.destroy()`. */
  dispose(): MaybePromise<void>;
}

export interface ContractContext {
  /** Creates a grid, mounts it with the given options, returns the driver. */
  create(opts: ContractGridOptions): MaybePromise<ContractGrid>;
}

export interface ContractCase {
  name: string;
  run(ctx: ContractContext): MaybePromise<void>;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`GridView contract violation: ${message}`);
}

// Lets adapters that scroll/paint asynchronously settle.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const VIEWPORT = { width: 400, height: 300 };

function makeDims(rowCount = 200, colCount = 50): GridDimensions {
  return {
    rowCount,
    colCount,
    rowHeight: (r) => 20 + (r % 3) * 4,
    colWidth: (c) => 60 + (c % 4) * 10,
    colLabel: (c) => `C${c}`,
  };
}

/** Mutable cell store: tests change `overrides`, the default text is derived from coords. */
function makeStore() {
  const overrides = new Map<string, string>();
  const key = (c: CellCoord) => `${c.row}:${c.col}`;
  return {
    set: (c: CellCoord, text: string) => overrides.set(key(c), text),
    getCell: (c: CellCoord): CellRenderData => ({
      text: overrides.get(key(c)) ?? `r${c.row}c${c.col}`,
    }),
    defaultText: (c: CellCoord) => `r${c.row}c${c.col}`,
  };
}

async function withGrid(
  ctx: ContractContext,
  opts: Partial<ContractGridOptions>,
  body: (g: ContractGrid, store: ReturnType<typeof makeStore>) => MaybePromise<void>,
): Promise<void> {
  const store = makeStore();
  const g = await ctx.create({
    dims: opts.dims ?? makeDims(),
    getCell: opts.getCell ?? store.getCell,
    viewport: opts.viewport ?? VIEWPORT,
  });
  try {
    await body(g, store);
  } finally {
    await g.dispose();
  }
}

function visibleCoords(g: ContractGrid): CellCoord[] {
  const { start, end } = g.view.getVisibleRange();
  const out: CellCoord[] = [];
  for (let row = start.row; row <= end.row; row++) {
    for (let col = start.col; col <= end.col; col++) out.push({ row, col });
  }
  return out;
}

function rectOf(g: ContractGrid, c: CellCoord) {
  const r = g.view.getCellRect(c);
  check(r !== null, `expected a rect for visible cell ${c.row},${c.col}`);
  return r;
}

function clientCentre(g: ContractGrid, c: CellCoord) {
  const r = rectOf(g, c);
  return g.viewportToClient(r.x + r.width / 2, r.y + r.height / 2);
}

function show(t: GridTarget | null): string {
  return t === null ? "null" : JSON.stringify(t);
}

export const gridViewContract: ContractCase[] = [
  {
    name: "hitTest of the centre of getCellRect(c) returns c for fully visible cells",
    run: (ctx) =>
      withGrid(ctx, {}, (g) => {
        let tested = 0;
        for (const c of visibleCoords(g)) {
          const r = g.view.getCellRect(c);
          if (!r) continue;
          const inside =
            r.x >= 0 &&
            r.y >= 0 &&
            r.x + r.width <= VIEWPORT.width &&
            r.y + r.height <= VIEWPORT.height;
          if (!inside) continue;
          const { clientX, clientY } = clientCentre(g, c);
          const hit = g.view.hitTest(clientX, clientY);
          check(
            hit !== null && !isHeaderHit(hit) && coordsEqual(hit, c),
            `hitTest at centre of ${c.row},${c.col} returned ${show(hit)}`,
          );
          tested++;
        }
        check(tested >= 6, `expected to test several visible cells, tested ${tested}`);
      }),
  },
  {
    name: "off-screen cells have null rects and getVisibleRange agrees with non-null rects",
    run: (ctx) =>
      withGrid(ctx, {}, async (g) => {
        check(g.view.getCellRect({ row: 199, col: 49 }) === null, "far cell must have null rect");
        check(g.view.getCellRect({ row: 0, col: 49 }) === null, "far column must have null rect");
        for (const [x, y] of [
          [0, 0],
          [0, 700],
          [500, 0],
          [500, 700],
        ] as const) {
          await g.scrollTo(x, y);
          const range = g.view.getVisibleRange();
          const dims = makeDims();
          for (let row = 0; row < dims.rowCount; row++) {
            for (let col = 0; col < dims.colCount; col++) {
              const c = { row, col };
              const hasRect = g.view.getCellRect(c) !== null;
              // Edge cells may be partly visible; the range must include every rect-holder.
              if (hasRect) {
                check(
                  rangeContains(range, c),
                  `cell ${row},${col} has a rect but is outside the visible range`,
                );
              }
            }
          }
          for (const c of [range.start, range.end]) {
            check(
              g.view.getCellRect(c) !== null,
              `visible range corner ${c.row},${c.col} has a null rect`,
            );
          }
        }
      }),
  },
  {
    name: "scrollIntoView makes a far cell visible",
    run: (ctx) =>
      withGrid(ctx, {}, async (g) => {
        const far = { row: 150, col: 40 };
        check(g.view.getCellRect(far) === null, "precondition: far cell starts off-screen");
        g.view.scrollIntoView(far);
        // Some adapters scroll asynchronously; give them a turn.
        await tick();
        check(g.view.getCellRect(far) !== null, "far cell has no rect after scrollIntoView");
        check(rangeContains(g.view.getVisibleRange(), far), "far cell not in visible range");
      }),
  },
  {
    name: "refreshCells([c]) updates exactly that cell; others stay stale",
    run: (ctx) =>
      withGrid(ctx, {}, async (g, store) => {
        const a = { row: 1, col: 1 };
        const b = { row: 2, col: 2 };
        check((await g.displayedText(a)) === store.defaultText(a), "initial text of a");
        store.set(a, "new-a");
        store.set(b, "new-b");
        g.view.refreshCells([a]);
        check((await g.displayedText(a)) === "new-a", "refreshed cell must show new text");
        check(
          (await g.displayedText(b)) === store.defaultText(b),
          "non-refreshed cell must stay stale",
        );
      }),
  },
  {
    name: 'refreshCells("all") updates every visible cell',
    run: (ctx) =>
      withGrid(ctx, {}, async (g, store) => {
        const cells = visibleCoords(g).slice(0, 12);
        for (const c of cells) store.set(c, `v2-${c.row}-${c.col}`);
        g.view.refreshCells("all");
        for (const c of cells) {
          check(
            (await g.displayedText(c)) === `v2-${c.row}-${c.col}`,
            `cell ${c.row},${c.col} not refreshed`,
          );
        }
      }),
  },
  {
    name: "setDimensions is reflected in geometry",
    run: (ctx) =>
      withGrid(ctx, {}, async (g) => {
        const wide: GridDimensions = {
          rowCount: 200,
          colCount: 60,
          rowHeight: () => 30,
          colWidth: () => 100,
          colLabel: (c) => `C${c}`,
        };
        g.view.setDimensions(wide);
        const r0 = rectOf(g, { row: 0, col: 0 });
        const r1 = rectOf(g, { row: 0, col: 1 });
        const r2 = rectOf(g, { row: 1, col: 0 });
        check(r0.width === 100 && r0.height === 30, `cell size not updated: ${JSON.stringify(r0)}`);
        check(r1.x - r0.x === 100, "column offset must follow new widths");
        check(r2.y - r0.y === 30, "row offset must follow new heights");
        const added = { row: 0, col: 55 };
        check(g.view.getCellRect(added) === null, "added column starts off-screen");
        g.view.scrollIntoView(added);
        await tick();
        check(g.view.getCellRect(added) !== null, "added column must be reachable");
      }),
  },
  {
    name: "hitTest recognises row header, column header, corner and outside",
    run: (ctx) =>
      withGrid(ctx, {}, (g) => {
        const r = rectOf(g, { row: 1, col: 2 });
        const at = (x: number, y: number) => {
          const p = g.viewportToClient(x, y);
          return g.view.hitTest(p.clientX, p.clientY);
        };
        const r00 = rectOf(g, { row: 0, col: 0 });
        const colHit = at(r.x + r.width / 2, r00.y - 1);
        check(
          targetsEqual(colHit, { kind: "colHeader", col: 2 }),
          `column header: got ${show(colHit)}`,
        );
        const rowHit = at(r00.x - 1, r.y + r.height / 2);
        check(
          targetsEqual(rowHit, { kind: "rowHeader", row: 1 }),
          `row header: got ${show(rowHit)}`,
        );
        const corner = at(r00.x - 1, r00.y - 1);
        check(targetsEqual(corner, { kind: "corner" }), `corner: got ${show(corner)}`);
        const outside = at(VIEWPORT.width + 10, VIEWPORT.height + 10);
        check(outside === null, `outside the grid must be null, got ${show(outside)}`);
        const negative = at(-5, -5);
        check(negative === null, `above/left of the grid must be null, got ${show(negative)}`);
      }),
  },
  {
    name: "a click emits pointerDown and pointerUp targeting the clicked cell",
    run: (ctx) =>
      withGrid(ctx, {}, async (g) => {
        const downs: [GridTarget, PointerInfo][] = [];
        const ups: [GridTarget | null, PointerInfo][] = [];
        g.view.on("pointerDown", (t, e) => downs.push([t, e]));
        g.view.on("pointerUp", (t, e) => ups.push([t, e]));
        const c = { row: 3, col: 2 };
        await g.click(c);
        check(downs.length === 1, `expected 1 pointerDown, got ${downs.length}`);
        check(ups.length === 1, `expected 1 pointerUp, got ${ups.length}`);
        check(targetsEqual(downs[0]![0], c), `pointerDown target ${show(downs[0]![0])}`);
        check(targetsEqual(ups[0]![0], c), `pointerUp target ${show(ups[0]![0])}`);
        check(downs[0]![1].button === 0, "pointerDown must report the primary button");
        check(downs[0]![1].shiftKey === false, "plain click must not report shiftKey");
      }),
  },
  {
    name: "a key press emits keyDown with plain key info",
    run: (ctx) =>
      withGrid(ctx, {}, async (g) => {
        const keys: KeyInfo[] = [];
        g.view.on("keyDown", (e) => keys.push(e));
        g.view.focus();
        await g.pressKey("ArrowDown");
        check(keys.length === 1, `expected 1 keyDown, got ${keys.length}`);
        check(keys[0]!.key === "ArrowDown", `unexpected key ${keys[0]!.key}`);
        check(keys[0]!.shiftKey === false && keys[0]!.metaKey === false, "modifiers must be false");
      }),
  },
  {
    name: "unsubscribe stops event delivery",
    run: (ctx) =>
      withGrid(ctx, {}, async (g) => {
        let count = 0;
        const off = g.view.on("pointerDown", () => count++);
        await g.click({ row: 0, col: 0 });
        check(count === 1, "handler must fire while subscribed");
        off();
        await g.click({ row: 0, col: 0 });
        check(count === 1, "handler must not fire after unsubscribe");
      }),
  },
  {
    name: "calls after destroy throw",
    run: (ctx) =>
      withGrid(ctx, {}, (g) => {
        const view = g.view;
        view.destroy();
        const calls: [string, () => unknown][] = [
          ["getCellRect", () => view.getCellRect({ row: 0, col: 0 })],
          ["hitTest", () => view.hitTest(10, 10)],
          ["getVisibleRange", () => view.getVisibleRange()],
          ["refreshCells", () => view.refreshCells("all")],
          ["scrollIntoView", () => view.scrollIntoView({ row: 0, col: 0 })],
          ["setDimensions", () => view.setDimensions(makeDims())],
          ["focus", () => view.focus()],
        ];
        for (const [name, fn] of calls) {
          let threw = false;
          try {
            fn();
          } catch {
            threw = true;
          }
          check(threw, `${name}() must throw after destroy()`);
        }
      }),
  },
];
