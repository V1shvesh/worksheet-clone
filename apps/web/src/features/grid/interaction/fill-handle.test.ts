import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { cellKey, getFormatsMap, readColOrder, readRowOrder } from "@worksheet-clone/shared";
import { LOCAL_ORIGIN } from "../../../crdt/origin";
import { createWorkbookUndo } from "../../../crdt/undo";
import { edit } from "../../../test-utils/workbook";
import { resolveSelection } from "./selection";
import { mountInteraction } from "./test-harness";

const mounted: ReturnType<typeof mountInteraction>[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.dispose();
});

function setup(opts: Parameters<typeof mountInteraction>[0] = {}) {
  const m = mountInteraction(opts);
  mounted.push(m);
  const txs: unknown[] = [];
  m.doc.on("afterTransaction", (tr: Y.Transaction) => {
    if (tr.changed.size > 0) txs.push(tr.origin);
  });
  const c = (row: number, col: number) => ({ row, col });
  const select = (a: [number, number], f: [number, number] = a) => {
    m.view.pointerDown(c(...a));
    if (f[0] !== a[0] || f[1] !== a[1]) m.view.pointerMove(c(...f));
    m.view.pointerUp(c(...f));
  };
  const centre = (row: number, col: number) => {
    const rect = m.view.getCellRect(c(row, col))!;
    return [rect.x + rect.width / 2, rect.y + rect.height / 2] as const;
  };
  /** Selects `from..to`, then drags the handle to the centre of `pointer`. */
  const drag = (from: [number, number], to: [number, number], pointer: [number, number]) => {
    select(from, to);
    txs.length = 0;
    expect(m.interaction.fill.begin()).toBe(true);
    m.interaction.fill.move(...centre(...pointer));
    m.interaction.fill.end(...centre(...pointer));
  };
  const put = (row: number, col: number, input: Parameters<typeof edit>[4]) => {
    edit(m.doc, m.sheetId, row, col, input);
  };
  const raw = (row: number, col: number) => m.model.getRawInput(c(row, col));
  const column = (col: number, from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => raw(from + i, col));
  const row = (r: number, from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => raw(r, from + i));
  const range = () => resolveSelection(m.store.getState().grid.selection, m.model)?.range;
  const preview = () => m.store.getState().grid.fillPreview;
  return { ...m, txs, c, select, centre, drag, put, raw, column, row, range, preview };
}

describe("fill handle drag", () => {
  it("fills down with a numeric series and selects source plus fill", () => {
    const t = setup();
    t.put(0, 0, { v: 1 });
    t.put(1, 0, { v: 2 });
    t.drag([0, 0], [1, 0], [5, 0]);
    expect(t.column(0, 0, 5)).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(t.range()).toEqual({ start: t.c(0, 0), end: t.c(5, 0) });
    expect(t.preview()).toBeNull();
  });

  it("fills right", () => {
    const t = setup();
    t.put(0, 0, { v: 10 });
    t.put(0, 1, { v: 20 });
    t.drag([0, 0], [0, 1], [0, 4]);
    expect(t.row(0, 0, 4)).toEqual(["10", "20", "30", "40", "50"]);
  });

  it("fills up and left backwards", () => {
    const t = setup();
    t.put(5, 0, { v: 5 });
    t.put(6, 0, { v: 6 });
    t.drag([5, 0], [6, 0], [2, 0]);
    expect(t.column(0, 2, 6)).toEqual(["2", "3", "4", "5", "6"]);
    t.put(9, 5, { v: 7 });
    t.put(9, 6, { v: 9 });
    t.drag([9, 5], [9, 6], [9, 3]);
    expect(t.row(9, 3, 6)).toEqual(["3", "5", "7", "9"]);
  });

  it("copies a single number and increments 'Item 1'", () => {
    const t = setup();
    t.put(0, 0, { v: 5 });
    t.put(0, 2, { v: "Item 1" });
    t.drag([0, 0], [0, 0], [3, 0]);
    expect(t.column(0, 0, 3)).toEqual(["5", "5", "5", "5"]);
    t.drag([0, 2], [0, 2], [3, 2]);
    expect(t.column(2, 0, 3)).toEqual(["Item 1", "Item 2", "Item 3", "Item 4"]);
  });

  it("fills a formula down ten rows with relative references", () => {
    const t = setup();
    for (let i = 0; i <= 10; i++) t.put(i, 0, { v: i + 1 });
    t.put(0, 1, { f: "=A1*2" });
    t.drag([0, 1], [0, 1], [10, 1]);
    expect(t.column(1, 0, 10)).toEqual(Array.from({ length: 11 }, (_, i) => `=A${i + 1}*2`));
    expect(t.model.getCell(t.c(10, 1)).text).toBe("22");
    expect(t.model.getCell(t.c(4, 1)).text).toBe("10");
  });

  it("fills a formula right, and absolute references stay", () => {
    const t = setup();
    t.put(0, 0, { f: "=$Z$1+A2" });
    t.drag([0, 0], [0, 0], [0, 2]);
    expect(t.row(0, 0, 2)).toEqual(["=$Z$1+A2", "=$Z$1+B2", "=$Z$1+C2"]);
  });

  it("repeats the source formats cyclically", () => {
    const t = setup();
    const rows = readRowOrder(t.doc, t.sheetId);
    const cols = readColOrder(t.doc, t.sheetId);
    t.put(0, 0, { v: 1 });
    t.put(1, 0, { v: 2 });
    t.doc.transact(() => {
      const formats = getFormatsMap(t.doc, t.sheetId);
      formats.set(cellKey(rows[0]!, cols[0]!), { b: true });
      formats.set(cellKey(rows[1]!, cols[0]!), { bg: "#fff2a8" });
    });
    t.drag([0, 0], [1, 0], [4, 0]);
    const fmt = (r: number) => getFormatsMap(t.doc, t.sheetId).get(cellKey(rows[r]!, cols[0]!));
    expect([fmt(2), fmt(3), fmt(4)]).toEqual([{ b: true }, { bg: "#fff2a8" }, { b: true }]);
  });

  it("is one transaction and one undo step", () => {
    const t = setup();
    const undo = createWorkbookUndo(t.doc, {
      isReadOnly: () => false,
      getContext: () => ({ sheetId: t.sheetId, selection: null }),
    });
    t.put(0, 0, { v: 3 });
    t.drag([0, 0], [0, 0], [9, 0]);
    expect(t.txs).toEqual([LOCAL_ORIGIN]);
    expect(t.raw(9, 0)).toBe("3");
    undo.undo();
    expect(t.column(0, 1, 9).every((v) => v === "")).toBe(true);
    expect(t.raw(0, 0)).toBe("3"); // the seed edit was not tracked
    undo.destroy();
  });

  it("previews while dragging along one axis, and releasing inside the selection does nothing", () => {
    const t = setup();
    t.put(0, 0, { v: 1 });
    t.select([0, 0], [1, 1]);
    t.interaction.fill.begin();
    t.interaction.fill.move(...t.centre(4, 2)); // 3 rows out, 1 col out: vertical
    expect(t.preview()).toEqual({ start: t.c(0, 0), end: t.c(4, 1) });
    t.interaction.fill.move(...t.centre(1, 5)); // now horizontal
    expect(t.preview()).toEqual({ start: t.c(0, 0), end: t.c(1, 5) });
    t.interaction.fill.move(...t.centre(0, 1)); // back inside
    expect(t.preview()).toBeNull();
    t.txs.length = 0;
    t.interaction.fill.end(...t.centre(0, 1));
    expect(t.txs).toHaveLength(0);
    expect(t.range()).toEqual({ start: t.c(0, 0), end: t.c(1, 1) });
  });

  it("Escape cancels the drag", () => {
    const t = setup();
    t.put(0, 0, { v: 1 });
    t.select([0, 0]);
    t.interaction.fill.begin();
    t.interaction.fill.move(...t.centre(4, 0));
    expect(t.preview()).not.toBeNull();
    t.view.keyDown({ key: "Escape" });
    expect(t.preview()).toBeNull();
    t.txs.length = 0;
    t.interaction.fill.end(...t.centre(4, 0));
    expect(t.txs).toHaveLength(0);
    expect(t.raw(4, 0)).toBe("");
  });

  it("a pointer outside the grid keeps the last extent", () => {
    const t = setup();
    t.put(0, 0, { v: 1 });
    t.select([0, 0]);
    t.interaction.fill.begin();
    t.interaction.fill.move(...t.centre(3, 0));
    t.interaction.fill.end(-50, -50);
    expect(t.column(0, 0, 3)).toEqual(["1", "1", "1", "1"]);
  });

  it("viewers cannot start a fill, and neither can an open editor", () => {
    const viewer = setup({ readOnly: true });
    viewer.put(0, 0, { v: 1 });
    viewer.select([0, 0]);
    expect(viewer.interaction.fill.begin()).toBe(false);
    const editor = setup();
    editor.select([0, 0]);
    editor.view.keyDown({ key: "F2" });
    expect(editor.interaction.fill.begin()).toBe(false);
  });
});
