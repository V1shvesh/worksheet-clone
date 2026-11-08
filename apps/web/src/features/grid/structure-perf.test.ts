import { afterEach, describe, expect, it } from "vitest";
import { addSheet, getColOrderArray, newId, readRowOrder } from "@worksheet-clone/shared";
import { deleteRows, insertRows } from "../../crdt/mutations";
import { createFormulaEngine, type EngineEvent } from "../../engine";
import { newDoc, put } from "../../test-utils/workbook";
import { FakeGridView } from "./adapters/fake/fake-grid-view";
import { connectModelToView, SheetViewModel } from "./model";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

// Targets are 100 ms per structure op; the asserted bound is looser so a slow CI runner does not
// flake. The measured numbers are printed so a regression is visible long before the bound.
const TARGET_MS = 100;
const BOUND_MS = 500;

describe("M7 performance: structure ops on 10,000 cells / 1,000 formulas", () => {
  it("insertRows and deleteRows in the middle reach the engine's change event quickly", () => {
    const { doc, sheetId } = newDoc();
    const ROWS = 100;
    const COLS = 100;
    let data = "";
    doc.transact(() => {
      const cols = getColOrderArray(doc, sheetId);
      cols.push(Array.from({ length: COLS - cols.length }, () => newId()));
      data = addSheet(doc, "Data");
    });
    // 9,000 constants (cols A-CL minus the last ten), plus 1,000 formulas in cols 90-99:
    // row ranges, a full-column range, per-row arithmetic and cross-sheet references.
    doc.transact(() => {
      for (let r = 0; r < ROWS; r++) {
        put(doc, data, r, 0, { v: r });
        for (let c = 0; c < 90; c++) put(doc, sheetId, r, c, { v: r * COLS + c });
        const n = r + 1;
        put(doc, sheetId, r, 90, { f: `=SUM(A${n}:J${n})` });
        put(doc, sheetId, r, 91, { f: "=SUM(A1:A100)" });
        put(doc, sheetId, r, 92, { f: `=A${n}+B${n}` });
        for (let c = 93; c < 97; c++) put(doc, sheetId, r, c, { f: `=A${n}*${c}` });
        put(doc, sheetId, r, 97, { f: `=Data!A${n}*2` });
        put(doc, sheetId, r, 98, { f: `=SUM(Data!A1:A${n})` });
        put(doc, sheetId, r, 99, { f: `=A${n}+1` });
      }
    });

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
    expect(model.getCell({ row: 5, col: 97 }).text).toBe("10");

    let eventAt = 0;
    const events: EngineEvent[] = [];
    engine.subscribe((e) => {
      if (eventAt === 0 && e.type === "rebuilt" && e.sheetId === sheetId)
        eventAt = performance.now();
      events.push(e);
    });
    const measure = (run: () => void) => {
      eventAt = 0;
      const start = performance.now();
      run();
      const end = performance.now();
      return { toEvent: eventAt - start, total: end - start };
    };

    const rows = readRowOrder(doc, sheetId);
    const insert = measure(() => {
      expect(insertRows(doc, false, sheetId, 50, 1).ok).toBe(true);
    });
    // Everything is consistent afterwards: formulas pointing below row 50 moved with their cells.
    expect(model.getRawInput({ row: 51, col: 92 })).toBe("=A52+B52");
    expect(model.getRawInput({ row: 0, col: 91 })).toBe("=SUM(A1:A101)");
    expect(model.getCell({ row: 6, col: 97 }).text).toBe("12");
    // Other sheets are untouched: the Data!A1:A51 range does not move with this sheet's rows.
    expect(model.getRawInput({ row: 51, col: 98 })).toBe("=SUM(Data!A1:A51)");

    const remove = measure(() => {
      expect(deleteRows(doc, false, sheetId, [rows[20]!]).ok).toBe(true);
    });
    expect(model.getRawInput({ row: 0, col: 91 })).toBe("=SUM(A1:A100)");
    expect(model.getCell({ row: 20, col: 0 }).text).toBe(String(21 * COLS));

    console.info(
      `[perf] insertRows (middle, 10k cells / 1k formulas): ${insert.toEvent.toFixed(1)} ms to the ` +
        `engine's rebuilt event, ${insert.total.toFixed(1)} ms for the whole transaction; ` +
        `deleteRows: ${remove.toEvent.toFixed(1)} ms to the event, ${remove.total.toFixed(1)} ms total ` +
        `(target ${TARGET_MS} ms, asserted bound ${BOUND_MS} ms)`,
    );
    expect(insert.toEvent).toBeGreaterThan(0);
    expect(remove.toEvent).toBeGreaterThan(0);
    expect(insert.toEvent).toBeLessThan(BOUND_MS);
    expect(remove.toEvent).toBeLessThan(BOUND_MS);
  });
});
