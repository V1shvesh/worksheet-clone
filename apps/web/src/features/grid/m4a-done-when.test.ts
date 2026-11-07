import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  getColOrderArray,
  getRowOrderArray,
  newId,
  readColOrder,
  readRowOrder,
} from "@worksheet-clone/shared";
import { createFormulaEngine, type FormulaEngine } from "../../engine";
import { newDoc, put } from "../../test-utils/workbook";
import { FakeGridView } from "./adapters/fake/fake-grid-view";
import { setCellInput } from "./commands/set-cell-input";
import { connectModelToView, SheetViewModel } from "./model";

const REMOTE = Symbol("remote");

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** Our side only: engine + model + mounted fake grid, wired together. */
function mountOurSide(doc: Y.Doc, sheetId: string) {
  const engine: FormulaEngine = createFormulaEngine(doc);
  const model = new SheetViewModel(doc, sheetId, engine);
  const view = new FakeGridView();
  view.mount(document.createElement("div"), model.dimensions(), (c) => model.getCell(c));
  const disconnect = connectModelToView(model, view);
  cleanups.push(() => {
    disconnect();
    view.destroy();
    model.destroy();
    engine.destroy();
  });
  return { engine, model, view };
}

function twoClients() {
  const ours = newDoc();
  const theirs = new Y.Doc();
  Y.applyUpdate(theirs, Y.encodeStateAsUpdate(ours.doc));
  const relay = (from: Y.Doc, to: Y.Doc) => {
    const onUpdate = (u: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) Y.applyUpdate(to, u, REMOTE);
    };
    from.on("update", onUpdate);
    cleanups.push(() => from.off("update", onUpdate));
  };
  relay(ours.doc, theirs);
  relay(theirs, ours.doc);
  return { doc: ours.doc, theirs, sheetId: ours.sheetId };
}

describe("M4a done-when: collaborator edit refreshes a dependent formula cell", () => {
  it("edits A2 remotely and our grid refreshes the =SUM(A1:A3) cell", () => {
    const { doc, theirs, sheetId } = twoClients();
    const { view } = mountOurSide(doc, sheetId);
    const ours = { doc, readOnly: false };
    const A = (row: number) => ({ row, col: 0 });

    setCellInput(ours, sheetId, A(0), "1");
    setCellInput(ours, sheetId, A(1), "2");
    setCellInput(ours, sheetId, A(2), "3");
    setCellInput(ours, sheetId, A(3), "=SUM(A1:A3)");
    expect(view.displayedText(A(3))).toBe("6");

    view.refreshLog.length = 0;
    setCellInput({ doc: theirs, readOnly: false }, sheetId, A(1), "10");

    const refreshed = view.refreshLog.flatMap((r) => (r === "all" ? [] : r));
    expect(refreshed).toContainEqual({ row: 3, col: 0 });
    expect(view.displayedText(A(3))).toBe("14");
    expect(view.displayedText(A(1))).toBe("10");
  });

  it("a remote row delete leaves surviving refs intact and turns refs to the deleted cell into #REF!", () => {
    const { doc, theirs, sheetId } = twoClients();
    const { model, view } = mountOurSide(doc, sheetId);
    const ours = { doc, readOnly: false };
    const A = (row: number) => ({ row, col: 0 });

    setCellInput(ours, sheetId, A(0), "1");
    setCellInput(ours, sheetId, A(1), "2");
    setCellInput(ours, sheetId, A(2), "3");
    setCellInput(ours, sheetId, A(3), "=SUM(A1:A3)");
    setCellInput(ours, sheetId, { row: 0, col: 1 }, "=A2*2");
    expect(view.displayedText({ row: 0, col: 1 })).toBe("4");

    theirs.transact(() => getRowOrderArray(theirs, sheetId).delete(1, 1));

    expect(readRowOrder(doc, sheetId)).toHaveLength(99);
    // Former A4 is now A3; the range endpoints survive, so it sums the remaining A1 and A3.
    expect(model.getCell(A(2)).text).toBe("4");
    expect(view.displayedText(A(2))).toBe("4");
    expect(model.getRawInput(A(2))).toBe("=SUM(A1:A2)");
    expect(view.displayedText({ row: 0, col: 1 })).toBe("#REF!");
    expect(model.getRawInput({ row: 0, col: 1 })).toContain("#REF!");
  });
});

describe("M4a performance: 10,000 cells / 1,000 formulas", () => {
  it("loads and propagates an edit within generous bounds", () => {
    const { doc, sheetId } = newDoc();
    const ROWS = 100;
    const COLS = 100;
    // Default sheets are 100x26, so grow the column order to 100 columns before filling.
    doc.transact(() => {
      const cols = getColOrderArray(doc, sheetId);
      cols.push(Array.from({ length: COLS - cols.length }, () => newId()));
    });
    expect(readRowOrder(doc, sheetId)).toHaveLength(ROWS);
    expect(readColOrder(doc, sheetId)).toHaveLength(COLS);

    // Cols 0-89 are constants. Cols 90-92 (300 formulas) all depend on A1;
    // cols 93-99 (700 formulas) are per-row and independent of A1 except row 1.
    doc.transact(() => {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < 90; c++) put(doc, sheetId, r, c, { v: r * COLS + c });
        for (let c = 90; c < 93; c++) put(doc, sheetId, r, c, { f: "=A1*2" });
        for (let c = 93; c < COLS; c++) put(doc, sheetId, r, c, { f: `=A${r + 1}+B${r + 1}` });
      }
    });

    const t0 = performance.now();
    const engine = createFormulaEngine(doc);
    const model = new SheetViewModel(doc, sheetId, engine);
    const view = new FakeGridView();
    view.mount(document.createElement("div"), model.dimensions(), (c) => model.getCell(c));
    const disconnect = connectModelToView(model, view);
    cleanups.push(() => {
      disconnect();
      view.destroy();
      model.destroy();
      engine.destroy();
    });
    const loadMs = performance.now() - t0;
    // Column 93 is outside the fake viewport, so read through the model, not the painted cache.
    expect(model.getCell({ row: 5, col: 93 }).text).toBe(String(5 * COLS + (5 * COLS + 1)));

    view.refreshLog.length = 0;
    const t1 = performance.now();
    setCellInput({ doc, readOnly: false }, sheetId, { row: 0, col: 0 }, "7");
    const editMs = performance.now() - t1;
    expect(model.getCell({ row: 99, col: 92 }).text).toBe("14");

    console.info(
      `[perf] initial load (engine+model+mount, 10000 cells, 1000 formulas): ${loadMs.toFixed(1)} ms; ` +
        `edit with 300+ dependents: ${editMs.toFixed(1)} ms`,
    );
    expect(loadMs).toBeLessThan(5000);
    expect(editMs).toBeLessThan(1000);
  });
});
