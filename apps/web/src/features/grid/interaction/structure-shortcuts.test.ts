import { afterEach, describe, expect, it, vi } from "vitest";
import { readColOrder, readRowOrder } from "@worksheet-clone/shared";
import type { StructureActions } from "../commands";
import { mountInteraction } from "./test-harness";

const mounted: ReturnType<typeof mountInteraction>[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.dispose();
});

function setup(readOnly = false) {
  const structure: StructureActions = {
    insertRows: vi.fn(),
    insertCols: vi.fn(),
    deleteRows: vi.fn(),
    deleteCols: vi.fn(),
  };
  const m = mountInteraction({ readOnly, structure });
  mounted.push(m);
  const rowHeaders = (from: number, to: number) => {
    m.view.pointerDown({ kind: "rowHeader", row: from });
    if (to !== from) m.view.pointerMove({ kind: "rowHeader", row: to });
    m.view.pointerUp({ kind: "rowHeader", row: to });
  };
  const colHeaders = (from: number, to: number) => {
    m.view.pointerDown({ kind: "colHeader", col: from });
    if (to !== from) m.view.pointerMove({ kind: "colHeader", col: to });
    m.view.pointerUp({ kind: "colHeader", col: to });
  };
  const cell = (row: number, col: number) => {
    m.view.pointerDown({ row, col });
    m.view.pointerUp({ row, col });
  };
  // A US layout: Ctrl+Alt is a real chord and no AltGr is held.
  const US_INSERT = { key: "=", code: "Equal", ctrlKey: true, altKey: true } as const;
  const US_DELETE = { key: "-", code: "Minus", ctrlKey: true, altKey: true } as const;
  return { ...m, structure, rowHeaders, colHeaders, cell, US_INSERT, US_DELETE };
}

describe("Ctrl+Alt+= / Ctrl+Alt+- (US layout)", () => {
  it("insert: whole rows insert that many rows above; whole columns insert columns to the left", () => {
    const t = setup();
    t.rowHeaders(2, 4);
    t.view.keyDown(t.US_INSERT);
    expect(t.structure.insertRows).toHaveBeenCalledWith(2, 3);
    t.colHeaders(1, 1);
    t.view.keyDown(t.US_INSERT);
    expect(t.structure.insertCols).toHaveBeenCalledWith(1, 1);
  });

  it("insert on plain cells inserts rows above the selection and starts no edit", () => {
    const t = setup();
    t.cell(5, 3);
    t.view.keyDown(t.US_INSERT);
    expect(t.structure.insertRows).toHaveBeenCalledWith(5, 1);
    expect(t.store.getState().grid.editing).toBeNull();
  });

  it("delete: whole rows pass stable row ids; whole columns pass column ids", () => {
    const t = setup();
    const rows = readRowOrder(t.doc, t.sheetId);
    const cols = readColOrder(t.doc, t.sheetId);
    t.rowHeaders(1, 2);
    t.view.keyDown(t.US_DELETE);
    expect(t.structure.deleteRows).toHaveBeenCalledWith([rows[1], rows[2]]);
    t.colHeaders(3, 3);
    t.view.keyDown(t.US_DELETE);
    expect(t.structure.deleteCols).toHaveBeenCalledWith([cols[3]]);
  });

  it("delete does nothing for a cell selection, and not for everything", () => {
    const t = setup();
    t.cell(2, 2);
    t.view.keyDown(t.US_DELETE);
    t.view.pointerDown({ kind: "corner" });
    t.view.pointerUp({ kind: "corner" });
    t.view.keyDown(t.US_DELETE);
    expect(t.structure.deleteRows).not.toHaveBeenCalled();
    expect(t.structure.deleteCols).not.toHaveBeenCalled();
  });

  it("viewers trigger nothing and nothing starts typing", () => {
    const t = setup(true);
    t.rowHeaders(0, 1);
    t.view.keyDown(t.US_INSERT);
    t.view.keyDown(t.US_DELETE);
    expect(t.structure.insertRows).not.toHaveBeenCalled();
    expect(t.structure.deleteRows).not.toHaveBeenCalled();
    expect(t.store.getState().grid.editing).toBeNull();
  });

  it("the physical key counts when the character differs (macOS Ctrl+Option+=)", () => {
    const t = setup();
    t.rowHeaders(0, 0);
    t.view.keyDown({ key: "≠", code: "Equal", ctrlKey: true, altKey: true });
    expect(t.structure.insertRows).toHaveBeenCalledWith(0, 1);
  });
});

describe("Ctrl+Alt with AltGr (German layout) still types", () => {
  it("AltGr+ß types a backslash: no structure change, an edit starts with that character", () => {
    const t = setup();
    t.rowHeaders(2, 3);
    t.view.keyDown({ key: "\\", code: "Minus", ctrlKey: true, altKey: true, altGraph: true });
    expect(t.structure.deleteRows).not.toHaveBeenCalled();
    expect(t.store.getState().grid.editing?.draft).toBe("\\");
  });

  it("even when AltGr produces = or -, it types instead of changing the structure", () => {
    for (const key of ["=", "-"]) {
      const t = setup();
      t.rowHeaders(2, 3);
      t.view.keyDown({ key, code: "Equal", ctrlKey: true, altKey: true, altGraph: true });
      expect(t.structure.insertRows).not.toHaveBeenCalled();
      expect(t.structure.deleteRows).not.toHaveBeenCalled();
      expect(t.store.getState().grid.editing?.draft).toBe(key);
    }
  });

  it("an AltGr-less Ctrl+Alt letter keeps its old meaning (typing, not a chord)", () => {
    const t = setup();
    t.cell(1, 1);
    t.view.keyDown({ key: "q", ctrlKey: true, altKey: true });
    expect(t.store.getState().grid.editing?.draft).toBe("q");
    expect(t.structure.insertRows).not.toHaveBeenCalled();
  });
});
