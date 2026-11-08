import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  getCell,
  getSheetName,
  isSheetHidden,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  setSheetHidden as hideInDoc,
} from "@worksheet-clone/shared";
import { createFormulaEngine } from "../engine";
import { asRemote } from "../test-utils/render-workbook";
import { newDoc, put as putInput } from "../test-utils/workbook";
import { LOCAL_ORIGIN } from "./origin";
import {
  addSheet,
  clearCells,
  deleteSheet,
  moveSheet,
  renameSheet,
  setCellContent,
  setSheetHidden,
} from "./mutations";
import { createWorkbookUndo, type UndoContext } from "./undo";

/** Two replicas of one workbook that exchange updates on demand. */
function twoClients() {
  const { doc: a, sheetId } = newDoc();
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const flush = () => {
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), "remote");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), "remote");
  };
  return { a, b, sheetId, flush };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function undoFor(
  doc: Y.Doc,
  context: () => UndoContext = () => ({ sheetId: null, selection: null }),
) {
  let readOnly = false;
  const undo = createWorkbookUndo(doc, { isReadOnly: () => readOnly, getContext: context });
  cleanups.push(() => undo.destroy());
  return {
    undo,
    setReadOnly(value: boolean) {
      readOnly = value;
    },
  };
}

function ids(doc: Y.Doc, sheetId: string) {
  return { r: readRowOrder(doc, sheetId), c: readColOrder(doc, sheetId) };
}

function put(doc: Y.Doc, sheetId: string, row: number, col: number, v: number | string) {
  const { r, c } = ids(doc, sheetId);
  return setCellContent(doc, false, sheetId, r[row]!, c[col]!, { v });
}

function value(doc: Y.Doc, sheetId: string, row: number, col: number) {
  const { r, c } = ids(doc, sheetId);
  return getCell(doc, sheetId, r[row]!, c[col]!)?.v;
}

describe("workbook undo", () => {
  it("undoes your own edit and redoes it", () => {
    const { a, sheetId } = twoClients();
    const { undo } = undoFor(a);
    put(a, sheetId, 0, 0, 1);
    put(a, sheetId, 0, 0, 2);
    expect(undo.undo()).not.toBeNull();
    expect(value(a, sheetId, 0, 0)).toBe(1);
    expect(undo.undo()).not.toBeNull();
    expect(value(a, sheetId, 0, 0)).toBeUndefined();
    expect(undo.undo()).toBeNull();
    expect(undo.redo()).not.toBeNull();
    expect(value(a, sheetId, 0, 0)).toBe(1);
    expect(undo.redo()).not.toBeNull();
    expect(value(a, sheetId, 0, 0)).toBe(2);
    expect(undo.redo()).toBeNull();
  });

  it("each separate transaction is its own step, even in quick succession", () => {
    const { a, sheetId } = twoClients();
    const { undo } = undoFor(a);
    for (let i = 0; i < 5; i++) put(a, sheetId, i, 0, i + 1);
    undo.undo();
    expect([0, 1, 2, 3, 4].map((i) => value(a, sheetId, i, 0))).toEqual([1, 2, 3, 4, undefined]);
  });

  it("a new action clears the redo stack", () => {
    const { a, sheetId } = twoClients();
    const { undo } = undoFor(a);
    put(a, sheetId, 0, 0, 1);
    undo.undo();
    expect(undo.getState()).toEqual({ canUndo: false, canRedo: true });
    put(a, sheetId, 1, 0, 9);
    expect(undo.getState()).toEqual({ canUndo: true, canRedo: false });
    expect(undo.redo()).toBeNull();
    expect(value(a, sheetId, 0, 0)).toBeUndefined();
  });

  it("a collaborator's later edit to a different cell survives your undo", () => {
    const { a, b, sheetId, flush } = twoClients();
    const { undo } = undoFor(a);
    put(a, sheetId, 0, 0, 1);
    flush();
    put(b, sheetId, 1, 0, 50);
    flush();
    undo.undo();
    flush();
    expect(value(a, sheetId, 0, 0)).toBeUndefined();
    expect(value(a, sheetId, 1, 0)).toBe(50);
    expect(value(b, sheetId, 1, 0)).toBe(50);
  });

  it("a collaborator who overwrote the same cell keeps their value when you undo", () => {
    const { a, b, sheetId, flush } = twoClients();
    const { undo } = undoFor(a);
    put(a, sheetId, 0, 0, 1);
    put(a, sheetId, 0, 0, 2);
    flush();
    put(b, sheetId, 0, 0, 99);
    flush();
    undo.undo();
    flush();
    expect(value(a, sheetId, 0, 0)).toBe(99);
    expect(value(b, sheetId, 0, 0)).toBe(99);
    // The step was spent on a cell they own now; it doesn't resurrect the older value.
    undo.undo();
    flush();
    expect(value(a, sheetId, 0, 0)).toBe(99);
  });

  it("remote changes never appear on your stack", () => {
    const { a, b, sheetId, flush } = twoClients();
    const { undo } = undoFor(a);
    put(b, sheetId, 0, 0, 5);
    flush();
    asRemote(a, () => undefined);
    expect(undo.getState()).toEqual({ canUndo: false, canRedo: false });
    expect(undo.undo()).toBeNull();
    expect(value(a, sheetId, 0, 0)).toBe(5);
  });

  it("clearing a range is one step", () => {
    const { a, sheetId } = twoClients();
    const { undo } = undoFor(a);
    for (let i = 0; i < 3; i++) put(a, sheetId, i, 0, i + 1);
    const { r, c } = ids(a, sheetId);
    clearCells(
      a,
      false,
      sheetId,
      r.slice(0, 3).map((rowId) => ({ rowId, colId: c[0]! })),
    );
    undo.undo();
    expect([0, 1, 2].map((i) => value(a, sheetId, i, 0))).toEqual([1, 2, 3]);
    undo.redo();
    expect([0, 1, 2].map((i) => value(a, sheetId, i, 0))).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  describe("sheet actions are one step each", () => {
    it("add", () => {
      const { a, sheetId } = twoClients();
      const { undo } = undoFor(a);
      const added = addSheet(a, false, sheetId)!;
      undo.undo();
      expect(readSheetOrder(a)).toEqual([sheetId]);
      undo.redo();
      expect(readSheetOrder(a)).toEqual([sheetId, added]);
    });

    it("rename", () => {
      const { a, sheetId } = twoClients();
      const { undo } = undoFor(a);
      renameSheet(a, false, sheetId, "Budget");
      undo.undo();
      expect(getSheetName(a, sheetId)).toBe("Sheet1");
      undo.redo();
      expect(getSheetName(a, sheetId)).toBe("Budget");
    });

    it("hide", () => {
      const { a, sheetId } = twoClients();
      const second = addSheet(a, false, sheetId)!;
      const { undo } = undoFor(a);
      setSheetHidden(a, false, second, true);
      expect(isSheetHidden(a, second)).toBe(true);
      undo.undo();
      expect(isSheetHidden(a, second)).toBe(false);
    });

    it("move", () => {
      const { a, sheetId } = twoClients();
      const second = addSheet(a, false, sheetId)!;
      const { undo } = undoFor(a);
      moveSheet(a, false, sheetId, 1);
      expect(readSheetOrder(a)).toEqual([second, sheetId]);
      undo.undo();
      expect(readSheetOrder(a)).toEqual([sheetId, second]);
      undo.redo();
      expect(readSheetOrder(a)).toEqual([second, sheetId]);
    });

    it("delete restores the sheet with its cells, name and position", () => {
      const { a, sheetId } = twoClients();
      const second = addSheet(a, false, sheetId)!;
      renameSheet(a, false, second, "Data");
      put(a, second, 2, 1, 42);
      const third = addSheet(a, false, second)!;
      const { undo } = undoFor(a);
      deleteSheet(a, false, second);
      expect(readSheetOrder(a)).toEqual([sheetId, third]);
      undo.undo();
      expect(readSheetOrder(a)).toEqual([sheetId, second, third]);
      expect(getSheetName(a, second)).toBe("Data");
      expect(value(a, second, 2, 1)).toBe(42);
      undo.redo();
      expect(readSheetOrder(a)).toEqual([sheetId, third]);
    });

    it("undoing a delete also restores formats and the sheet visibility flag", () => {
      const { a, sheetId } = twoClients();
      const second = addSheet(a, false, sheetId)!;
      a.transact(() => hideInDoc(a, second, true));
      const { undo } = undoFor(a);
      deleteSheet(a, false, second);
      undo.undo();
      expect(isSheetHidden(a, second)).toBe(true);
    });
  });

  it("undoing a sheet delete brings back a formula elsewhere that referenced it", () => {
    const { a, sheetId } = twoClients();
    const data = addSheet(a, false, sheetId)!;
    renameSheet(a, false, data, "Data");
    put(a, data, 0, 0, 21);
    // A formula on Sheet1 pointing at Data!A1, written through the real encoder path.
    const engine = createFormulaEngine(a);
    cleanups.push(() => engine.destroy());
    a.transact(() => putInput(a, sheetId, 0, 0, { f: "=Data!A1*2" }), LOCAL_ORIGIN);
    const { undo } = undoFor(a);
    expect(engine.getValue(sheetId, 0, 0)).toBe(42);
    deleteSheet(a, false, data);
    expect(engine.getValue(sheetId, 0, 0)).toMatchObject({ value: "#REF!" });
    undo.undo();
    expect(engine.getValue(sheetId, 0, 0)).toBe(42);
  });

  describe("view restore context", () => {
    const ctx = (row: string): UndoContext => ({
      sheetId: "s",
      selection: { anchor: { rowId: row, colId: "c" }, focus: { rowId: row, colId: "c" } },
    });

    it("undo and redo both restore the context of the original action", () => {
      const { a, sheetId } = twoClients();
      let current = ctx("r1");
      const { undo } = undoFor(a, () => current);
      put(a, sheetId, 0, 0, 1);
      current = ctx("r2"); // where the user wandered off to
      expect(undo.undo()).toEqual({ context: ctx("r1") });
      current = ctx("r3");
      expect(undo.redo()).toEqual({ context: ctx("r1") });
      current = ctx("r4");
      expect(undo.undo()).toEqual({ context: ctx("r1") });
    });

    it("each step keeps its own context", () => {
      const { a, sheetId } = twoClients();
      let current = ctx("r1");
      const { undo } = undoFor(a, () => current);
      put(a, sheetId, 0, 0, 1);
      current = ctx("r2");
      put(a, sheetId, 1, 0, 1);
      expect(undo.undo()?.context).toEqual(ctx("r2"));
      expect(undo.undo()?.context).toEqual(ctx("r1"));
    });
  });

  it("is refused while read-only, and canUndo reflects nothing is lost", () => {
    const { a, sheetId } = twoClients();
    const { undo, setReadOnly } = undoFor(a);
    put(a, sheetId, 0, 0, 1);
    setReadOnly(true);
    expect(undo.undo()).toBeNull();
    expect(value(a, sheetId, 0, 0)).toBe(1);
    setReadOnly(false);
    expect(undo.undo()).not.toBeNull();
  });

  it("notifies subscribers when the stacks change", () => {
    const { a, sheetId } = twoClients();
    const { undo } = undoFor(a);
    let calls = 0;
    const off = undo.subscribe(() => calls++);
    put(a, sheetId, 0, 0, 1);
    expect(calls).toBe(1);
    undo.undo();
    expect(calls).toBe(2);
    off();
    put(a, sheetId, 0, 0, 2);
    expect(calls).toBe(2);
  });
});
