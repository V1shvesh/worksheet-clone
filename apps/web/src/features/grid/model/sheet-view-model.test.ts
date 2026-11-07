import { afterEach, describe, expect, it } from "vitest";
import {
  addSheet,
  getColWidthsMap,
  getFormatsMap,
  getRowHeightsMap,
  getRowOrderArray,
  cellKey,
  readColOrder,
  readRowOrder,
} from "@worksheet-clone/shared";
import { createFormulaEngine, type FormulaEngine } from "../../../engine";
import { edit, newDoc, put } from "../../../test-utils/workbook";
import { FakeGridView } from "../adapters/fake/fake-grid-view";
import { connectModelToView } from "./connect-model-to-view";
import { SheetViewModel, type ModelEvent } from "./sheet-view-model";

function setup() {
  const { doc, sheetId } = newDoc();
  const engine = createFormulaEngine(doc);
  const model = new SheetViewModel(doc, sheetId, engine);
  return { doc, sheetId, engine, model };
}

describe("SheetViewModel", () => {
  const disposables: { destroy(): void }[] = [];
  const track = <T extends { destroy(): void }>(d: T): T => {
    disposables.push(d);
    return d;
  };
  function make() {
    const s = setup();
    track(s.engine);
    track(s.model);
    return s;
  }
  afterEach(() => {
    for (const d of disposables.splice(0)) d.destroy();
  });

  it("maps indices to ids and back", () => {
    const { doc, sheetId, model } = make();
    const rows = readRowOrder(doc, sheetId);
    const cols = readColOrder(doc, sheetId);
    expect(model.dimensions().rowCount).toBe(rows.length);
    expect(model.dimensions().colCount).toBe(cols.length);
    expect(model.rowIdAt(3)).toBe(rows[3]);
    expect(model.colIdAt(5)).toBe(cols[5]);
    expect(model.rowIndexOf(rows[7]!)).toBe(7);
    expect(model.colIndexOf(cols[9]!)).toBe(9);
    expect(model.rowIdAt(1000)).toBeUndefined();
    expect(model.rowIndexOf("nope")).toBeUndefined();
  });

  it("invalidates the index cache when the order changes", () => {
    const { doc, sheetId, model } = make();
    const rows = readRowOrder(doc, sheetId);
    doc.transact(() => getRowOrderArray(doc, sheetId).delete(0, 1));
    expect(model.rowIdAt(0)).toBe(rows[1]);
    expect(model.rowIndexOf(rows[0]!)).toBeUndefined();
    expect(model.rowIndexOf(rows[1]!)).toBe(0);
    expect(model.dimensions().rowCount).toBe(rows.length - 1);
  });

  it("reports labels and default and custom sizes", () => {
    const { doc, sheetId, model } = make();
    const dims = model.dimensions();
    expect(dims.colLabel(0)).toBe("A");
    expect(dims.colLabel(26)).toBe("AA");
    expect(dims.rowHeight(0)).toBe(24);
    expect(dims.colWidth(0)).toBe(100);
    doc.transact(() => {
      getRowHeightsMap(doc, sheetId).set(model.rowIdAt(2)!, 40);
      getColWidthsMap(doc, sheetId).set(model.colIdAt(1)!, 150);
    });
    const next = model.dimensions();
    expect(next.rowHeight(2)).toBe(40);
    expect(next.rowHeight(3)).toBe(24);
    expect(next.colWidth(1)).toBe(150);
  });

  describe("getCell", () => {
    it("renders numbers without float noise, booleans, text and empties", () => {
      const { doc, sheetId, model } = make();
      doc.transact(() => {
        put(doc, sheetId, 0, 0, { f: "=0.1+0.2" });
        put(doc, sheetId, 1, 0, { v: 42 });
        put(doc, sheetId, 2, 0, { v: true });
        put(doc, sheetId, 3, 0, { v: false });
        put(doc, sheetId, 4, 0, { v: "hello" });
        put(doc, sheetId, 5, 0, { v: "007" });
        put(doc, sheetId, 6, 0, { f: "=1/3" });
        put(doc, sheetId, 7, 0, { f: "=B1" });
      });
      const text = (row: number) => model.getCell({ row, col: 0 }).text;
      expect(text(0)).toBe("0.3");
      expect(text(1)).toBe("42");
      expect(text(2)).toBe("TRUE");
      expect(text(3)).toBe("FALSE");
      expect(text(4)).toBe("hello");
      expect(text(5)).toBe("007");
      expect(text(6)).toBe("0.33333333333");
      // A reference to an empty cell is 0, as in Excel and Google Sheets.
      expect(text(7)).toBe("0");
      expect(model.getCell({ row: 20, col: 0 })).toEqual({ text: "" });
    });

    it("renders errors with the error flag", () => {
      const { doc, sheetId, model } = make();
      edit(doc, sheetId, 0, 0, { f: "=1/0" });
      edit(doc, sheetId, 1, 0, { f: "=FOO()" });
      expect(model.getCell({ row: 0, col: 0 })).toEqual({ text: "#DIV/0!", error: true });
      expect(model.getCell({ row: 1, col: 0 })).toEqual({ text: "#NAME?", error: true });
    });

    it("includes the cell's format and returns empty outside the grid", () => {
      const { doc, sheetId, model } = make();
      const key = cellKey(model.rowIdAt(1)!, model.colIdAt(2)!);
      doc.transact(() => getFormatsMap(doc, sheetId).set(key, { bg: "#ff0", b: true }));
      expect(model.getCell({ row: 1, col: 2 })).toEqual({
        text: "",
        format: { bg: "#ff0", b: true },
      });
      expect(model.getCell({ row: -1, col: 0 })).toEqual({ text: "" });
      expect(model.getCell({ row: 0, col: 99 })).toEqual({ text: "" });
    });
  });

  describe("getRawInput", () => {
    it("shows A1 formulas, numbers, booleans and text", () => {
      const { doc, sheetId, model } = make();
      doc.transact(() => {
        put(doc, sheetId, 0, 0, { v: 1.5 });
        put(doc, sheetId, 1, 0, { f: "=A1*2" });
        put(doc, sheetId, 2, 0, { v: true });
        put(doc, sheetId, 3, 0, { v: "text" });
      });
      expect(model.getRawInput({ row: 0, col: 0 })).toBe("1.5");
      expect(model.getRawInput({ row: 1, col: 0 })).toBe("=A1*2");
      expect(model.getRawInput({ row: 2, col: 0 })).toBe("TRUE");
      expect(model.getRawInput({ row: 3, col: 0 })).toBe("text");
      expect(model.getRawInput({ row: 4, col: 0 })).toBe("");
      expect(model.getRawInput({ row: -1, col: 0 })).toBe("");
    });

    it("follows row deletion: refs shift, deleted referents become #REF!", () => {
      const { doc, sheetId, model } = make();
      doc.transact(() => {
        put(doc, sheetId, 0, 0, { v: 1 });
        put(doc, sheetId, 1, 0, { v: 2 });
        put(doc, sheetId, 2, 0, { f: "=A1+A2" });
      });
      // Deleting the row above shifts references up.
      doc.transact(() => getRowOrderArray(doc, sheetId).delete(0, 1));
      expect(model.getRawInput({ row: 1, col: 0 })).toBe("=#REF!+A1");
      expect(model.getCell({ row: 1, col: 0 })).toEqual({ text: "#REF!", error: true });
    });
  });

  describe("change events", () => {
    function record(model: SheetViewModel): ModelEvent[] {
      const events: ModelEvent[] = [];
      model.subscribe((e) => events.push(e));
      return events;
    }

    it("emits edited and dependent cells for a value change", () => {
      const { doc, sheetId, model } = make();
      doc.transact(() => {
        put(doc, sheetId, 0, 0, { v: 1 });
        put(doc, sheetId, 1, 0, { f: "=A1+1" });
      });
      const events = record(model);
      edit(doc, sheetId, 0, 0, { v: 5 });
      expect(events).toHaveLength(1);
      const e = events[0]!;
      expect(e.type).toBe("cells");
      expect(e.type === "cells" && e.cells).toEqual(
        expect.arrayContaining([
          { row: 0, col: 0 },
          { row: 1, col: 0 },
        ]),
      );
    });

    it("emits a cells event for format changes", () => {
      const { doc, sheetId, model } = make();
      const events = record(model);
      doc.transact(() => {
        const formats = getFormatsMap(doc, sheetId);
        formats.set(cellKey(model.rowIdAt(2)!, model.colIdAt(3)!), { b: true });
        formats.set(cellKey(model.rowIdAt(4)!, model.colIdAt(0)!), { i: true });
      });
      expect(events).toEqual([
        {
          type: "cells",
          cells: [
            { row: 2, col: 3 },
            { row: 4, col: 0 },
          ],
        },
      ]);
    });

    it("emits dimensions for size changes", () => {
      const { doc, sheetId, model } = make();
      const events = record(model);
      doc.transact(() => getRowHeightsMap(doc, sheetId).set(model.rowIdAt(0)!, 50));
      expect(events).toEqual([{ type: "dimensions" }]);
      doc.transact(() => getColWidthsMap(doc, sheetId).set(model.colIdAt(0)!, 80));
      expect(events).toEqual([{ type: "dimensions" }, { type: "dimensions" }]);
    });

    it("emits dimensions for order changes, after the engine has rebuilt", () => {
      const { doc, sheetId, model, engine } = make();
      doc.transact(() => {
        put(doc, sheetId, 0, 0, { v: 1 });
        put(doc, sheetId, 1, 0, { f: "=A1" });
      });
      let valueAtNotify: unknown = "unset";
      model.subscribe((e) => {
        if (e.type === "dimensions") valueAtNotify = engine.getValue(sheetId, 0, 0);
      });
      const events = record(model);
      doc.transact(() => getRowOrderArray(doc, sheetId).delete(0, 1));
      expect(events).toEqual([{ type: "dimensions" }]);
      // Row 0 is now the old row 1: its formula's referent is gone.
      expect(valueAtNotify).toMatchObject({ value: "#REF!" });
    });

    it("stops emitting after unsubscribe and destroy", () => {
      const { doc, sheetId, model } = make();
      const events: ModelEvent[] = [];
      const off = model.subscribe((e) => events.push(e));
      off();
      edit(doc, sheetId, 0, 0, { v: 1 });
      expect(events).toEqual([]);
      model.subscribe((e) => events.push(e));
      model.destroy();
      edit(doc, sheetId, 0, 0, { v: 2 });
      expect(events).toEqual([]);
    });

    it("ignores changes to other sheets", () => {
      const { doc, model } = make();
      doc.transact(() => addSheet(doc, "Other", "other"));
      const events = record(model);
      edit(doc, "other", 0, 0, { v: 1 });
      expect(events).toEqual([]);
    });
  });
});

describe("connectModelToView", () => {
  let engine: FormulaEngine;
  afterEach(() => engine.destroy());

  function mounted() {
    const { doc, sheetId } = newDoc();
    engine = createFormulaEngine(doc);
    const model = new SheetViewModel(doc, sheetId, engine);
    const view = new FakeGridView();
    view.mount(document.createElement("div"), model.dimensions(), (c) => model.getCell(c));
    const disconnect = connectModelToView(model, view);
    return { doc, sheetId, model, view, disconnect };
  }

  it("refreshes changed cells on the view", () => {
    const { doc, sheetId, view } = mounted();
    doc.transact(() => {
      put(doc, sheetId, 0, 0, { v: 1 });
      put(doc, sheetId, 1, 0, { f: "=A1*10" });
    });
    expect(view.displayedText({ row: 1, col: 0 })).toBe("10");
    edit(doc, sheetId, 0, 0, { v: 2 });
    expect(view.displayedText({ row: 1, col: 0 })).toBe("20");
    const last = view.refreshLog.at(-1)!;
    expect(last).toEqual(
      expect.arrayContaining([
        { row: 0, col: 0 },
        { row: 1, col: 0 },
      ]),
    );
  });

  it("sends new dimensions then refreshes everything after a size change", () => {
    const { doc, sheetId, model, view } = mounted();
    const before = view.refreshLog.length;
    doc.transact(() => getColWidthsMap(doc, sheetId).set(model.colIdAt(0)!, 200));
    expect(view.getCellRect({ row: 0, col: 0 })?.width).toBe(200);
    expect(view.refreshLog.slice(before)).toEqual(["all"]);
  });

  it("shows #REF! on the view after a structure delete", () => {
    const { doc, sheetId, view } = mounted();
    doc.transact(() => {
      put(doc, sheetId, 0, 0, { v: 1 });
      put(doc, sheetId, 1, 0, { f: "=A1" });
    });
    doc.transact(() => getRowOrderArray(doc, sheetId).delete(0, 1));
    expect(view.displayedText({ row: 0, col: 0 })).toBe("#REF!");
  });

  it("stops driving the view once disconnected", () => {
    const { doc, sheetId, view, disconnect } = mounted();
    disconnect();
    const before = view.refreshLog.length;
    edit(doc, sheetId, 0, 0, { v: 9 });
    expect(view.refreshLog.length).toBe(before);
  });
});
