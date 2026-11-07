import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
  addSheet,
  getRowOrderArray,
  getSheetOrderArray,
  getSheetsMap,
} from "@worksheet-clone/shared";
import { DetailedCellError } from "hyperformula";
import { edit, newDoc, put } from "../test-utils/workbook";
import { createFormulaEngine, type EngineEvent, type FormulaEngine } from "./formula-engine";

function errorOf(value: unknown): string {
  expect(value).toBeInstanceOf(DetailedCellError);
  return (value as DetailedCellError).value;
}

describe("formula engine", () => {
  let engine: FormulaEngine | undefined;
  afterEach(() => {
    engine?.destroy();
    engine = undefined;
  });

  it("loads values and formulas from the doc", () => {
    const { doc, sheetId } = newDoc();
    doc.transact(() => {
      put(doc, sheetId, 0, 0, { v: 1 });
      put(doc, sheetId, 1, 0, { v: 2 });
      put(doc, sheetId, 2, 0, { f: "=SUM(A1:A2)" });
      put(doc, sheetId, 0, 1, { v: "hi" });
      put(doc, sheetId, 1, 1, { v: true });
    });
    engine = createFormulaEngine(doc);
    expect(engine.getValue(sheetId, 2, 0)).toBe(3);
    expect(engine.getValue(sheetId, 0, 1)).toBe("hi");
    expect(engine.getValue(sheetId, 1, 1)).toBe(true);
    expect(engine.getValue(sheetId, 50, 20)).toBeNull();
    expect(engine.getValue("nope", 0, 0)).toBeNull();
  });

  it("treats a reference to an empty cell as 0, like Excel and Google Sheets", () => {
    const { doc, sheetId } = newDoc();
    doc.transact(() => {
      put(doc, sheetId, 0, 0, { f: "=B1" });
      put(doc, sheetId, 1, 0, { f: "=B1+1" });
    });
    engine = createFormulaEngine(doc);
    expect(engine.getValue(sheetId, 0, 0)).toBe(0);
    expect(engine.getValue(sheetId, 1, 0)).toBe(1);
    expect(engine.getValue(sheetId, 0, 1)).toBeNull();
  });

  it("recomputes a dependent and reports both edited and dependent cells", () => {
    const { doc, sheetId } = newDoc();
    doc.transact(() => {
      put(doc, sheetId, 0, 0, { v: 1 });
      put(doc, sheetId, 1, 0, { v: 2 });
      put(doc, sheetId, 2, 0, { v: 3 });
      put(doc, sheetId, 3, 0, { f: "=SUM(A1:A3)" });
    });
    engine = createFormulaEngine(doc);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    edit(doc, sheetId, 1, 0, { v: 10 });

    expect(engine.getValue(sheetId, 3, 0)).toBe(14);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("cells");
    if (event.type !== "cells") return;
    expect(event.sheetId).toBe(sheetId);
    expect(event.cells).toEqual(
      expect.arrayContaining([
        { row: 1, col: 0 },
        { row: 3, col: 0 },
      ]),
    );
  });

  it("propagates through a chain of dependents", () => {
    const { doc, sheetId } = newDoc();
    doc.transact(() => {
      put(doc, sheetId, 0, 0, { v: 1 });
      put(doc, sheetId, 0, 1, { f: "=A1+1" });
      put(doc, sheetId, 0, 2, { f: "=B1*2" });
      put(doc, sheetId, 0, 3, { f: "=C1+100" });
    });
    engine = createFormulaEngine(doc);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    edit(doc, sheetId, 0, 0, { v: 5 });
    expect(engine.getValue(sheetId, 0, 3)).toBe(112);
    const cells = events.flatMap((e) => (e.type === "cells" ? e.cells : []));
    for (const col of [0, 1, 2, 3]) expect(cells).toContainEqual({ row: 0, col });
  });

  it("notifies once per Yjs transaction", () => {
    const { doc, sheetId } = newDoc();
    engine = createFormulaEngine(doc);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    doc.transact(() => {
      put(doc, sheetId, 0, 0, { v: 1 });
      put(doc, sheetId, 1, 0, { v: 2 });
      put(doc, sheetId, 2, 0, { f: "=A1+A2" });
    });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type === "cells" && event.cells.length).toBe(3);
    expect(engine.getValue(sheetId, 2, 0)).toBe(3);
  });

  it("clearing a cell recomputes dependents", () => {
    const { doc, sheetId } = newDoc();
    doc.transact(() => {
      put(doc, sheetId, 0, 0, { v: 4 });
      put(doc, sheetId, 1, 0, { f: "=A1+1" });
    });
    engine = createFormulaEngine(doc);
    edit(doc, sheetId, 0, 0, undefined);
    expect(engine.getValue(sheetId, 0, 0)).toBeNull();
    expect(engine.getValue(sheetId, 1, 0)).toBe(1);
  });

  it("turns errors into values and never throws", () => {
    const { doc, sheetId } = newDoc();
    doc.transact(() => {
      put(doc, sheetId, 0, 0, { f: "=1/0" });
      put(doc, sheetId, 1, 0, { f: "=FOO()" });
      put(doc, sheetId, 2, 0, { f: "=1+" });
      put(doc, sheetId, 3, 0, { f: "=SUM(" });
      put(doc, sheetId, 4, 0, { f: "=A1+1" });
    });
    expect(() => (engine = createFormulaEngine(doc))).not.toThrow();
    const e = engine!;
    expect(errorOf(e.getValue(sheetId, 0, 0))).toBe("#DIV/0!");
    expect(errorOf(e.getValue(sheetId, 1, 0))).toBe("#NAME?");
    expect(errorOf(e.getValue(sheetId, 2, 0))).toBe("#ERROR!");
    expect(errorOf(e.getValue(sheetId, 3, 0))).toBe("#ERROR!");
    expect(errorOf(e.getValue(sheetId, 4, 0))).toBe("#DIV/0!");

    expect(() => edit(doc, sheetId, 5, 0, { f: "=)(" })).not.toThrow();
    expect(errorOf(e.getValue(sheetId, 5, 0))).toBe("#ERROR!");
  });

  it("deleting a referenced row id yields #REF! after the rebuild", () => {
    const { doc, sheetId } = newDoc();
    doc.transact(() => {
      put(doc, sheetId, 0, 0, { v: 1 });
      put(doc, sheetId, 1, 0, { v: 2 });
      put(doc, sheetId, 2, 0, { f: "=A2+1" });
      put(doc, sheetId, 3, 0, { f: "=SUM(A1:A2)" });
    });
    engine = createFormulaEngine(doc);
    expect(engine.getValue(sheetId, 2, 0)).toBe(3);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    doc.transact(() => getRowOrderArray(doc, sheetId).delete(1, 1));

    expect(events).toContainEqual({ type: "rebuilt", sheetId });
    // The formulas moved up one row.
    expect(errorOf(engine.getValue(sheetId, 1, 0))).toBe("#REF!");
    expect(errorOf(engine.getValue(sheetId, 2, 0))).toBe("#REF!");
  });

  it("loads a sheet added later and drops a removed one", () => {
    const { doc, sheetId } = newDoc();
    engine = createFormulaEngine(doc);
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));

    doc.transact(() => {
      addSheet(doc, "Second", "s2");
      put(doc, "s2", 0, 0, { v: 7 });
      put(doc, "s2", 1, 0, { f: "=A1*2" });
    });
    expect(events).toContainEqual({ type: "rebuilt", sheetId: "s2" });
    expect(engine.getValue("s2", 1, 0)).toBe(14);

    doc.transact(() => {
      getSheetsMap(doc).delete("s2");
      getSheetOrderArray(doc).delete(1, 1);
    });
    expect(engine.getValue("s2", 1, 0)).toBeNull();
    edit(doc, sheetId, 0, 0, { v: 1 });
    expect(engine.getValue(sheetId, 0, 0)).toBe(1);
  });

  describe("text stays text", () => {
    it.each(["007", "1/2", "=x", "TRUE", "FALSE", "1e3", "'quoted", "12"])(
      "keeps %j as a string",
      (text) => {
        const { doc, sheetId } = newDoc();
        doc.transact(() => put(doc, sheetId, 0, 0, { v: text }));
        engine = createFormulaEngine(doc);
        expect(engine.getValue(sheetId, 0, 0)).toBe(text);
        // Also via the incremental path.
        edit(doc, sheetId, 1, 0, { v: text });
        expect(engine.getValue(sheetId, 1, 0)).toBe(text);
      },
    );

    it("does not feed text values into formulas as numbers", () => {
      const { doc, sheetId } = newDoc();
      doc.transact(() => {
        put(doc, sheetId, 0, 0, { v: "007" });
        put(doc, sheetId, 1, 0, { f: "=ISTEXT(A1)" });
      });
      engine = createFormulaEngine(doc);
      expect(engine.getValue(sheetId, 1, 0)).toBe(true);
    });
  });

  it("two docs syncing the same edits compute identical values", () => {
    const a = newDoc();
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(a.doc));
    const link = (from: Y.Doc, to: Y.Doc) =>
      from.on("update", (update: Uint8Array, origin: unknown) => {
        if (origin !== "remote") Y.applyUpdate(to, update, "remote");
      });
    link(a.doc, docB);
    link(docB, a.doc);
    const engineA = createFormulaEngine(a.doc);
    const engineB = createFormulaEngine(docB);
    try {
      const id = a.sheetId;
      edit(a.doc, id, 0, 0, { v: 2 });
      edit(docB, id, 1, 0, { v: 5 });
      edit(a.doc, id, 2, 0, { f: "=A1*A2" });
      edit(docB, id, 3, 0, { f: "=A3+1" });
      for (let row = 0; row < 4; row++) {
        expect(engineB.getValue(id, row, 0)).toEqual(engineA.getValue(id, row, 0));
      }
      expect(engineA.getValue(id, 3, 0)).toBe(11);
    } finally {
      engineA.destroy();
      engineB.destroy();
    }
  });

  it("destroy stops listening to the doc", () => {
    const { doc, sheetId } = newDoc();
    const e = createFormulaEngine(doc);
    const listener = vi.fn();
    e.subscribe(listener);
    e.destroy();
    edit(doc, sheetId, 0, 0, { v: 1 });
    expect(listener).not.toHaveBeenCalled();
  });
});
