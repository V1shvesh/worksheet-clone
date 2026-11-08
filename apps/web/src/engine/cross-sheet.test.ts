import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { DetailedCellError } from "hyperformula";
import {
  addSheet,
  deleteSheet,
  getRowOrderArray,
  getSheetsMap,
  readRowOrder,
  setSheetName,
} from "@worksheet-clone/shared";
import { LOCAL_ORIGIN } from "../crdt/origin";
import { edit, newDoc, put } from "../test-utils/workbook";
import { createFormulaEngine, type EngineEvent, type FormulaEngine } from "./formula-engine";
import { FakeGridView } from "../features/grid/adapters/fake/fake-grid-view";
import { connectModelToView, SheetViewModel } from "../features/grid/model";

function errorOf(value: unknown): string {
  expect(value).toBeInstanceOf(DetailedCellError);
  return (value as DetailedCellError).value;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

/** A doc with Sheet1 and a second sheet named `name`. */
function twoSheets(name = "Sheet2") {
  const { doc, sheetId } = newDoc();
  let other = "";
  doc.transact(() => {
    other = addSheet(doc, name);
  });
  const engine: FormulaEngine = createFormulaEngine(doc);
  cleanups.push(() => engine.destroy());
  return { doc, sheetId, other, engine };
}

describe("cross-sheet references in the engine", () => {
  it("evaluates a formula that points at another sheet and follows its edits", () => {
    const { doc, sheetId, other, engine } = twoSheets();
    edit(doc, other, 0, 0, { v: 4 });
    edit(doc, sheetId, 0, 0, { f: "=Sheet2!A1*2" });
    expect(engine.getValue(sheetId, 0, 0)).toBe(8);

    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    edit(doc, other, 0, 0, { v: 10 });
    expect(engine.getValue(sheetId, 0, 0)).toBe(20);
    const forSheet1 = events.find((e) => e.type === "cells" && e.sheetId === sheetId);
    expect(forSheet1).toMatchObject({ cells: expect.arrayContaining([{ row: 0, col: 0 }]) });
  });

  it("loads cross-sheet formulas present in the doc at startup, in either sheet order", () => {
    const { doc, sheetId } = newDoc();
    let other = "";
    doc.transact(() => {
      other = addSheet(doc, "Data");
      put(doc, other, 0, 0, { v: 3 });
      put(doc, sheetId, 0, 0, { f: "=Data!A1+1" });
      put(doc, other, 1, 0, { f: "=Sheet1!A1+1" });
    });
    const engine = createFormulaEngine(doc);
    cleanups.push(() => engine.destroy());
    expect(engine.getValue(sheetId, 0, 0)).toBe(4);
    expect(engine.getValue(other, 1, 0)).toBe(5);
  });

  it("supports ranges across sheets and quoted names", () => {
    const { doc, sheetId, other, engine } = twoSheets("My Data");
    doc.transact(() => {
      put(doc, other, 0, 0, { v: 1 });
      put(doc, other, 1, 0, { v: 2 });
      put(doc, other, 2, 0, { v: 3 });
      put(doc, sheetId, 0, 0, { f: "=SUM('My Data'!A1:A3)" });
    });
    expect(engine.getValue(sheetId, 0, 0)).toBe(6);
    edit(doc, other, 1, 0, { v: 20 });
    expect(engine.getValue(sheetId, 0, 0)).toBe(24);
  });

  it("keeps the value when the referenced sheet is renamed", () => {
    const { doc, sheetId, other, engine } = twoSheets();
    edit(doc, other, 0, 0, { v: 5 });
    edit(doc, sheetId, 0, 0, { f: "=Sheet2!A1" });
    doc.transact(() => setSheetName(doc, other, "Renamed"), LOCAL_ORIGIN);
    expect(engine.getValue(sheetId, 0, 0)).toBe(5);
    edit(doc, other, 0, 0, { v: 6 });
    expect(engine.getValue(sheetId, 0, 0)).toBe(6);
  });

  it("shows #REF! when the referenced sheet is deleted and the value after undo", () => {
    const { doc, sheetId, other, engine } = twoSheets();
    edit(doc, other, 0, 0, { v: 7 });
    edit(doc, sheetId, 0, 0, { f: "=Sheet2!A1*2" });
    edit(doc, sheetId, 1, 0, { f: "=SUM(Sheet2!A1:A2)" });
    const undo = new Y.UndoManager([doc.getMap("sheets"), doc.getArray("sheetOrder")], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 0,
    });
    cleanups.push(() => undo.destroy());

    doc.transact(() => deleteSheet(doc, other), LOCAL_ORIGIN);
    expect(errorOf(engine.getValue(sheetId, 0, 0))).toBe("#REF!");
    expect(errorOf(engine.getValue(sheetId, 1, 0))).toBe("#REF!");

    undo.undo();
    expect(getSheetsMap(doc).has(other)).toBe(true);
    expect(engine.getValue(sheetId, 0, 0)).toBe(14);
    expect(engine.getValue(sheetId, 1, 0)).toBe(7);
  });

  it("restores a formula that was re-decoded while its sheet was missing", () => {
    const { doc, sheetId, other, engine } = twoSheets();
    edit(doc, other, 0, 0, { v: 7 });
    edit(doc, sheetId, 0, 0, { f: "=Sheet2!A1*2" });
    const undo = new Y.UndoManager([doc.getMap("sheets"), doc.getArray("sheetOrder")], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
      captureTimeout: 0,
    });
    cleanups.push(() => undo.destroy());
    doc.transact(() => deleteSheet(doc, other), LOCAL_ORIGIN);
    // Rebuilding Sheet1 decodes its formula while Sheet2 does not exist (a
    // remote edit, so the undo manager does not track it).
    doc.transact(() => getRowOrderArray(doc, sheetId).insert(0, ["top"]));
    expect(errorOf(engine.getValue(sheetId, 1, 0))).toBe("#REF!");

    undo.undo();
    expect(engine.getValue(sheetId, 1, 0)).toBe(14);
  });

  it("re-decodes dependents when the target's rows change (insert above)", () => {
    const { doc, sheetId, other, engine } = twoSheets();
    edit(doc, other, 1, 0, { v: 9 }); // Sheet2!A2
    edit(doc, sheetId, 0, 0, { f: "=Sheet2!A2" });
    expect(engine.getValue(sheetId, 0, 0)).toBe(9);

    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    // A new row at the top: the referenced cell is now A3 on Sheet2.
    doc.transact(() => getRowOrderArray(doc, other).insert(0, ["new-row"]));
    expect(engine.getValue(sheetId, 0, 0)).toBe(9);
    expect(events).toContainEqual({ type: "rebuilt", sheetId: other });
    expect(
      events.some(
        (e) =>
          e.type === "cells" &&
          e.sheetId === sheetId &&
          e.cells.some((c) => c.row === 0 && c.col === 0),
      ),
    ).toBe(true);
    // And it keeps following the cell, not the position.
    edit(doc, other, 2, 0, { v: 11 });
    expect(engine.getValue(sheetId, 0, 0)).toBe(11);
  });

  it("deleting the referenced row on another sheet gives #REF!", () => {
    const { doc, sheetId, other, engine } = twoSheets();
    edit(doc, other, 1, 0, { v: 9 });
    edit(doc, sheetId, 0, 0, { f: "=Sheet2!A2" });
    const rowId = readRowOrder(doc, other)[1]!;
    doc.transact(() => {
      const rows = getRowOrderArray(doc, other);
      rows.delete(rows.toArray().indexOf(rowId), 1);
    });
    expect(errorOf(engine.getValue(sheetId, 0, 0))).toBe("#REF!");
  });

  it("keeps a formula with an unknown sheet name verbatim and shows #REF!", () => {
    const { doc, sheetId, engine } = twoSheets();
    edit(doc, sheetId, 0, 0, { f: "=Nowhere!A1+1" });
    expect(errorOf(engine.getValue(sheetId, 0, 0))).toBe("#REF!");
  });

  it("applies cross-sheet changes in one batch per Yjs transaction", () => {
    const { doc, sheetId, other, engine } = twoSheets();
    edit(doc, sheetId, 0, 0, { f: "=Sheet2!A1+Sheet2!A2" });
    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    doc.transact(() => {
      put(doc, other, 0, 0, { v: 1 });
      put(doc, other, 1, 0, { v: 2 });
    });
    expect(engine.getValue(sheetId, 0, 0)).toBe(3);
    expect(events.filter((e) => e.type === "cells" && e.sheetId === sheetId)).toHaveLength(1);
  });
});

describe("cross-sheet references in the view model", () => {
  it("shows sheet names in the raw input, follows renames, and refreshes the view", () => {
    const { doc, sheetId, other, engine } = twoSheets();
    edit(doc, other, 0, 0, { v: 4 });
    edit(doc, sheetId, 0, 0, { f: "=Sheet2!A1*2" });
    const model = new SheetViewModel(doc, sheetId, engine);
    const view = new FakeGridView();
    view.mount(document.createElement("div"), model.dimensions(), (c) => model.getCell(c));
    const disconnect = connectModelToView(model, view);
    cleanups.push(() => {
      disconnect();
      view.destroy();
      model.destroy();
    });

    expect(model.getRawInput({ row: 0, col: 0 })).toBe("=Sheet2!A1*2");
    expect(model.getCell({ row: 0, col: 0 }).text).toBe("8");

    edit(doc, other, 0, 0, { v: 10 });
    expect(model.getCell({ row: 0, col: 0 }).text).toBe("20");

    doc.transact(() => setSheetName(doc, other, "My Data"), LOCAL_ORIGIN);
    expect(model.getRawInput({ row: 0, col: 0 })).toBe("='My Data'!A1*2");
    expect(model.getCell({ row: 0, col: 0 }).text).toBe("20");

    doc.transact(() => deleteSheet(doc, other), LOCAL_ORIGIN);
    expect(model.getCell({ row: 0, col: 0 }).text).toBe("#REF!");
  });
});
