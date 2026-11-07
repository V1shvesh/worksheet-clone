import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getCell, readColOrder, readRowOrder } from "@worksheet-clone/shared";
import { LOCAL_ORIGIN } from "../../../crdt/origin";
import { createFormulaEngine, type FormulaEngine } from "../../../engine";
import { edit, newDoc } from "../../../test-utils/workbook";
import { FakeGridView } from "../adapters/fake/fake-grid-view";
import { connectModelToView, SheetViewModel } from "../model";
import { setCellInput } from "./set-cell-input";

function stored(doc: Y.Doc, sheetId: string, row: number, col: number) {
  return getCell(doc, sheetId, readRowOrder(doc, sheetId)[row]!, readColOrder(doc, sheetId)[col]!);
}

function recordTransactions(doc: Y.Doc): unknown[] {
  const origins: unknown[] = [];
  doc.on("afterTransaction", (tr: Y.Transaction) => {
    if (tr.changed.size > 0) origins.push(tr.origin);
  });
  return origins;
}

describe("setCellInput", () => {
  it("writes the right CellData for each input kind", () => {
    const { doc, sheetId } = newDoc();
    const t = { doc, readOnly: false };
    setCellInput(t, sheetId, { row: 0, col: 0 }, "42");
    setCellInput(t, sheetId, { row: 1, col: 0 }, "hello");
    setCellInput(t, sheetId, { row: 2, col: 0 }, "TRUE");
    setCellInput(t, sheetId, { row: 3, col: 0 }, "'007");
    expect(stored(doc, sheetId, 0, 0)).toEqual({ v: 42 });
    expect(stored(doc, sheetId, 1, 0)).toEqual({ v: "hello" });
    expect(stored(doc, sheetId, 2, 0)).toEqual({ v: true });
    expect(stored(doc, sheetId, 3, 0)).toEqual({ v: "007" });
  });

  it("clears a cell on empty input", () => {
    const { doc, sheetId } = newDoc();
    const t = { doc, readOnly: false };
    setCellInput(t, sheetId, { row: 0, col: 0 }, "1");
    expect(setCellInput(t, sheetId, { row: 0, col: 0 }, "  ")).toBe(true);
    expect(stored(doc, sheetId, 0, 0)).toBeUndefined();
  });

  it("stores formulas with id refs and no A1 refs", () => {
    const { doc, sheetId } = newDoc();
    setCellInput({ doc, readOnly: false }, sheetId, { row: 3, col: 0 }, "=SUM(A1:A3)+B2");
    const f = stored(doc, sheetId, 3, 0)?.f;
    expect(f).toContain("[[");
    expect(f).not.toMatch(/\bA1\b|\bA3\b|\bB2\b/);
    expect(f?.startsWith("=SUM(")).toBe(true);
  });

  it("turns a reference outside the grid into #REF!", () => {
    const { doc, sheetId } = newDoc();
    const t = { doc, readOnly: false };
    setCellInput(t, sheetId, { row: 0, col: 0 }, "=A500");
    setCellInput(t, sheetId, { row: 1, col: 0 }, "=AAA1+1");
    const engine = createFormulaEngine(doc);
    const model = new SheetViewModel(doc, sheetId, engine);
    try {
      expect(model.getCell({ row: 0, col: 0 })).toEqual({ text: "#REF!", error: true });
      expect(model.getCell({ row: 1, col: 0 })).toEqual({ text: "#REF!", error: true });
      expect(model.getRawInput({ row: 0, col: 0 })).toBe("=#REF!");
    } finally {
      model.destroy();
      engine.destroy();
    }
  });

  it("is exactly one LOCAL_ORIGIN transaction per call", () => {
    const { doc, sheetId } = newDoc();
    const origins = recordTransactions(doc);
    setCellInput({ doc, readOnly: false }, sheetId, { row: 0, col: 0 }, "=1+1");
    setCellInput({ doc, readOnly: false }, sheetId, { row: 1, col: 0 }, "5");
    expect(origins).toEqual([LOCAL_ORIGIN, LOCAL_ORIGIN]);
  });

  it("refuses while read-only and outside the grid, writing nothing", () => {
    const { doc, sheetId } = newDoc();
    const origins = recordTransactions(doc);
    expect(setCellInput({ doc, readOnly: true }, sheetId, { row: 0, col: 0 }, "1")).toBe(false);
    for (const coord of [
      { row: 100, col: 0 },
      { row: 0, col: 26 },
      { row: -1, col: 0 },
      { row: 0, col: -1 },
    ]) {
      expect(setCellInput({ doc, readOnly: false }, sheetId, coord, "1")).toBe(false);
    }
    expect(origins).toEqual([]);
    expect(stored(doc, sheetId, 0, 0)).toBeUndefined();
  });
});

describe("engine + view model + fake grid", () => {
  let engine: FormulaEngine;
  afterEach(() => engine.destroy());

  it("recomputes and refreshes dependents when an input cell changes", () => {
    const { doc, sheetId } = newDoc();
    engine = createFormulaEngine(doc);
    const model = new SheetViewModel(doc, sheetId, engine);
    const view = new FakeGridView();
    view.mount(document.createElement("div"), model.dimensions(), (c) => model.getCell(c));
    connectModelToView(model, view);
    const t = { doc, readOnly: false };

    setCellInput(t, sheetId, { row: 0, col: 0 }, "1");
    setCellInput(t, sheetId, { row: 1, col: 0 }, "2");
    setCellInput(t, sheetId, { row: 2, col: 0 }, "3");
    setCellInput(t, sheetId, { row: 3, col: 0 }, "=SUM(A1:A3)");
    expect(view.displayedText({ row: 3, col: 0 })).toBe("6");

    setCellInput(t, sheetId, { row: 1, col: 0 }, "10");
    const last = view.refreshLog.at(-1);
    expect(last).toEqual(
      expect.arrayContaining([
        { row: 1, col: 0 },
        { row: 3, col: 0 },
      ]),
    );
    expect(view.displayedText({ row: 3, col: 0 })).toBe("14");
    expect(view.displayedText({ row: 1, col: 0 })).toBe("10");
    expect(model.getRawInput({ row: 3, col: 0 })).toBe("=SUM(A1:A3)");
    model.destroy();
  });
});

describe("editing a cell without changing it keeps its content", () => {
  it.each([
    ["number", { v: 42 }],
    ["boolean", { v: false }],
    ["plain text", { v: "hello" }],
    ["text that looks like a number", { v: "007" }],
    ["text that looks like a boolean", { v: "TRUE" }],
    ["text that looks like a formula", { v: "=not a formula" }],
    ["text starting with an apostrophe", { v: "'quoted" }],
    ["whitespace-only text", { v: "   " }],
    ["text with surrounding spaces", { v: "  padded  " }],
  ] as const)("%s", (_label, data) => {
    const { doc, sheetId } = newDoc();
    const engine = createFormulaEngine(doc);
    const model = new SheetViewModel(doc, sheetId, engine);
    const coord = { row: 0, col: 0 };
    edit(doc, sheetId, 0, 0, data);

    setCellInput({ doc, readOnly: false }, sheetId, coord, model.getRawInput(coord));

    expect(stored(doc, sheetId, 0, 0)).toEqual(data);
    model.destroy();
    engine.destroy();
  });
});
