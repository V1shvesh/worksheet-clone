import { describe, expect, it, vi } from "vitest";
import type { CellCoord, GridDimensions } from "../../port/types";
import { FakeGridView } from "./fake-grid-view";

const dims = (rows: number, cols: number, rowH = 20, colW = 100): GridDimensions => ({
  rowCount: rows,
  colCount: cols,
  rowHeight: () => rowH,
  colWidth: () => colW,
  colLabel: (c) => String.fromCharCode(65 + c),
});

function mounted(opts?: ConstructorParameters<typeof FakeGridView>[0], d = dims(100, 20)) {
  const view = new FakeGridView(opts);
  const reads: CellCoord[] = [];
  view.mount(document.createElement("div"), d, (c) => {
    reads.push(c);
    return { text: `${c.row},${c.col}` };
  });
  return { view, reads };
}

describe("FakeGridView geometry", () => {
  it("places cells after the headers (defaults 48 x 24)", () => {
    const { view } = mounted();
    expect(view.getCellRect({ row: 0, col: 0 })).toEqual({ x: 48, y: 24, width: 100, height: 20 });
    expect(view.getCellRect({ row: 2, col: 3 })).toEqual({ x: 348, y: 64, width: 100, height: 20 });
  });

  it("reports partly visible cells and hides fully clipped ones", () => {
    const { view } = mounted({ viewportWidth: 200, viewportHeight: 100 });
    // cells area is 152 wide: col 1 spans 148..248 in viewport coords, so it is partly visible
    expect(view.getCellRect({ row: 0, col: 1 })).not.toBeNull();
    expect(view.getCellRect({ row: 0, col: 2 })).toBeNull();
    view.scrollTo(60, 0);
    expect(view.getCellRect({ row: 0, col: 0 })).toEqual({ x: -12, y: 24, width: 100, height: 20 });
    view.scrollTo(100, 0);
    expect(view.getCellRect({ row: 0, col: 0 })).toBeNull();
  });

  it("returns null for out-of-range coordinates", () => {
    const { view } = mounted();
    expect(view.getCellRect({ row: -1, col: 0 })).toBeNull();
    expect(view.getCellRect({ row: 100, col: 0 })).toBeNull();
  });

  it("clamps scrollTo and emits scroll only when the offset changes", () => {
    const { view } = mounted({ viewportWidth: 248, viewportHeight: 124 }, dims(10, 5));
    const onScroll = vi.fn();
    view.on("scroll", onScroll);
    view.scrollTo(-50, -50);
    expect(onScroll).not.toHaveBeenCalled();
    view.scrollTo(10_000, 10_000);
    // content 500x200, area 200x100
    expect(view.scrollOffset).toEqual({ x: 300, y: 100 });
    expect(onScroll).toHaveBeenCalledTimes(1);
    view.scrollTo(10_000, 10_000);
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(onScroll.mock.calls[0]![0]).toEqual(view.getVisibleRange());
  });

  it("scrollIntoView scrolls minimally", () => {
    const { view } = mounted({ viewportWidth: 248, viewportHeight: 124 }, dims(100, 20));
    view.scrollIntoView({ row: 10, col: 0 });
    // row 10 spans 200..220, area height 100 -> scrollY = 120 (cell flush with bottom edge)
    expect(view.scrollOffset).toEqual({ x: 0, y: 120 });
    view.scrollIntoView({ row: 10, col: 0 });
    expect(view.scrollOffset).toEqual({ x: 0, y: 120 });
    view.scrollIntoView({ row: 0, col: 0 });
    expect(view.scrollOffset).toEqual({ x: 0, y: 0 });
  });

  it("scrollIntoView rejects out-of-range cells", () => {
    const { view } = mounted();
    expect(() => view.scrollIntoView({ row: 1000, col: 0 })).toThrow(RangeError);
  });

  it("hitTest maps headers, cells and out-of-content points", () => {
    const { view } = mounted({ viewportWidth: 800, viewportHeight: 600 }, dims(3, 2));
    expect(view.hitTest(10, 10)).toEqual({ kind: "corner" });
    expect(view.hitTest(60, 10)).toEqual({ kind: "colHeader", col: 0 });
    expect(view.hitTest(10, 50)).toEqual({ kind: "rowHeader", row: 1 });
    expect(view.hitTest(60, 30)).toEqual({ row: 0, col: 0 });
    expect(view.hitTest(48 + 100, 24)).toEqual({ row: 0, col: 1 });
    // past the last row / column but inside the viewport
    expect(view.hitTest(60, 24 + 60)).toBeNull();
    expect(view.hitTest(48 + 200, 30)).toBeNull();
    expect(view.hitTest(10, 24 + 60)).toBeNull();
    expect(view.hitTest(800, 10)).toBeNull();
  });

  it("handles an empty grid", () => {
    const { view } = mounted({}, dims(0, 0));
    expect(view.getCellRect({ row: 0, col: 0 })).toBeNull();
    expect(view.hitTest(100, 100)).toBeNull();
    expect(view.getVisibleRange().end.row).toBe(-1);
  });
});

describe("FakeGridView rendering cache", () => {
  it("caches only visible cells on mount", () => {
    const { view, reads } = mounted({ viewportWidth: 248, viewportHeight: 124 });
    // area 200x100 with 100x20 cells: rows 0..4 x cols 0..1
    expect(reads).toHaveLength(10);
    expect(view.displayedText({ row: 4, col: 1 })).toBe("4,1");
    expect(view.displayedText({ row: 5, col: 0 })).toBeNull();
    expect(view.displayedText({ row: 0, col: 2 })).toBeNull();
  });

  it("refreshCells ignores cells that are not rendered", () => {
    const { view, reads } = mounted();
    const before = reads.length;
    view.refreshCells([{ row: 99, col: 19 }]);
    expect(reads.length).toBe(before);
    expect(view.displayedText({ row: 99, col: 19 })).toBeNull();
    expect(view.refreshLog).toEqual([[{ row: 99, col: 19 }]]);
  });

  it("scrolling keeps stale cache for still-visible cells and reads newly visible ones", () => {
    const store = new Map<string, string>();
    const view = new FakeGridView({ viewportWidth: 248, viewportHeight: 124 });
    view.mount(document.createElement("div"), dims(100, 20), (c) => ({
      text: store.get(`${c.row}:${c.col}`) ?? "orig",
    }));
    store.set("1:0", "changed");
    store.set("20:0", "far");
    view.scrollTo(0, 20); // rows 1..6 visible; row 1 stays cached, row 5/6 are new
    expect(view.displayedText({ row: 1, col: 0 })).toBe("orig");
    expect(view.displayedText({ row: 0, col: 0 })).toBeNull();
    view.scrollTo(0, 400);
    expect(view.displayedText({ row: 20, col: 0 })).toBe("far");
  });

  it("setDimensions re-reads visible cells", () => {
    let text = "a";
    const view = new FakeGridView();
    view.mount(document.createElement("div"), dims(10, 5), () => ({ text }));
    text = "b";
    view.setDimensions(dims(10, 6));
    expect(view.displayedText({ row: 0, col: 0 })).toBe("b");
  });
});

describe("FakeGridView lifecycle and events", () => {
  it("throws a clear error before mount", () => {
    const view = new FakeGridView();
    expect(() => view.getCellRect({ row: 0, col: 0 })).toThrow(/before mount/);
    expect(() => view.refreshCells("all")).toThrow(/before mount/);
    expect(() => view.destroy()).toThrow(/before mount/);
    expect(() => view.on("scroll", () => {})).not.toThrow();
  });

  it("throws after destroy and cannot be remounted", () => {
    const { view } = mounted();
    view.destroy();
    expect(() => view.hitTest(1, 1)).toThrow(/after destroy/);
    expect(() => view.displayedText({ row: 0, col: 0 })).toThrow(/after destroy/);
    expect(() =>
      view.mount(document.createElement("div"), dims(1, 1), () => ({ text: "" })),
    ).toThrow();
  });

  it("simulated input emits plain event payloads", () => {
    const { view } = mounted();
    const down = vi.fn();
    const key = vi.fn();
    const ctxMenu = vi.fn();
    view.on("pointerDown", down);
    view.on("keyDown", key);
    view.on("contextMenu", ctxMenu);
    view.pointerDown({ kind: "corner" }, { shiftKey: true, clientX: 5 });
    view.keyDown({ key: "Enter", metaKey: true });
    view.contextMenu({ row: 1, col: 1 }, 7, 9);
    expect(down).toHaveBeenCalledWith(
      { kind: "corner" },
      expect.objectContaining({ shiftKey: true, clientX: 5, button: 0, ctrlKey: false }),
    );
    expect(key).toHaveBeenCalledWith(
      expect.objectContaining({ key: "Enter", code: "Enter", metaKey: true }),
    );
    expect(ctxMenu).toHaveBeenCalledWith({ row: 1, col: 1 }, 7, 9);
  });

  it("emits resize and move requests", () => {
    const { view } = mounted();
    const resized = vi.fn();
    const moved = vi.fn();
    view.on("columnResized", resized);
    view.on("rowMoveRequested", moved);
    view.columnResized(2, 150);
    view.rowMoveRequested(3, 8);
    expect(resized).toHaveBeenCalledWith(2, 150);
    expect(moved).toHaveBeenCalledWith(3, 8);
  });

  it("supports multiple handlers and independent unsubscribe", () => {
    const { view } = mounted();
    const a = vi.fn();
    const b = vi.fn();
    const offA = view.on("doubleClick", a);
    view.on("doubleClick", b);
    offA();
    view.doubleClick({ row: 0, col: 0 });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });
});
