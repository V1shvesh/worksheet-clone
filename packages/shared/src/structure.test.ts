import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addSheet,
  cellKey,
  createEmptyWorkbook,
  getCell,
  getCellsMap,
  getColWidthsMap,
  getFormatsMap,
  getRowHeightsMap,
  getRowOrderArray,
  getSheetsMap,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  setCell,
} from "./doc-schema.js";
import {
  MAX_COL_COUNT,
  MAX_ROW_COUNT,
  deleteCols,
  deleteRows,
  insertCols,
  insertRows,
} from "./structure.js";

function createPair(): { a: Y.Doc; b: Y.Doc; sheetId: string; sync: () => void } {
  const a = new Y.Doc();
  createEmptyWorkbook(a);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const sheetId = readSheetOrder(a)[0] as string;
  const sync = () => {
    // Exchange full state both ways, twice, so neither side misses the other's changes.
    for (let i = 0; i < 2; i++) {
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    }
  };
  return { a, b, sheetId, sync };
}

function single(): { doc: Y.Doc; sheetId: string } {
  const doc = new Y.Doc();
  createEmptyWorkbook(doc);
  return { doc, sheetId: readSheetOrder(doc)[0] as string };
}

describe("insertRows / insertCols", () => {
  it("inserts fresh ids at the visual index and returns them", () => {
    const { doc, sheetId } = single();
    const before = readRowOrder(doc, sheetId);
    const ids = insertRows(doc, sheetId, 4, 2);
    expect(ids).toHaveLength(2);
    const after = readRowOrder(doc, sheetId);
    expect(after).toHaveLength(102);
    expect(after.slice(4, 6)).toEqual(ids);
    expect(after.filter((id) => !(ids as string[]).includes(id))).toEqual(before);
  });

  it("inserts at the end and clamps out-of-range positions", () => {
    const { doc, sheetId } = single();
    const [last] = insertCols(doc, sheetId, 26, 1) as string[];
    expect(readColOrder(doc, sheetId).at(-1)).toBe(last);
    const [first] = insertCols(doc, sheetId, -5, 1) as string[];
    expect(readColOrder(doc, sheetId)[0]).toBe(first);
  });

  it("maps a deduped index to the right raw index when the array holds duplicates", () => {
    const { doc, sheetId } = single();
    const order = getRowOrderArray(doc, sheetId);
    const [r0, r1] = order.toArray() as [string, string];
    order.insert(1, [r0]); // raw: r0 r0 r1 ... ; deduped: r0 r1 ...
    const [id] = insertRows(doc, sheetId, 1, 1) as string[];
    const visible = readRowOrder(doc, sheetId);
    expect(visible.slice(0, 3)).toEqual([r0, id, r1]);
  });

  it("refuses to pass the caps and writes nothing", () => {
    const { doc, sheetId } = single();
    expect(insertRows(doc, sheetId, 0, MAX_ROW_COUNT)).toBeNull();
    expect(insertCols(doc, sheetId, 0, MAX_COL_COUNT)).toBeNull();
    expect(insertRows(doc, sheetId, 0, 0)).toBeNull();
    expect(readRowOrder(doc, sheetId)).toHaveLength(100);
    expect(readColOrder(doc, sheetId)).toHaveLength(26);
    expect(insertRows(doc, sheetId, 0, MAX_ROW_COUNT - 100)).toHaveLength(MAX_ROW_COUNT - 100);
    expect(insertRows(doc, sheetId, 0, 1)).toBeNull();
  });
});

describe("deleteRows / deleteCols", () => {
  it("removes the ids and every cell, format and size entry that mentions them", () => {
    const { doc, sheetId } = single();
    const rows = readRowOrder(doc, sheetId);
    const cols = readColOrder(doc, sheetId);
    const [r0, r1, r2] = rows as [string, string, string];
    const [c0, c1] = cols as [string, string];
    setCell(doc, sheetId, r1, c0, { v: 1 });
    setCell(doc, sheetId, r1, c1, { v: 2 });
    setCell(doc, sheetId, r0, c1, { v: 3 });
    getFormatsMap(doc, sheetId).set(cellKey(r1, c0), { b: true });
    getFormatsMap(doc, sheetId).set(cellKey(r0, c0), { b: true });
    getRowHeightsMap(doc, sheetId).set(r1, 40);
    getRowHeightsMap(doc, sheetId).set(r2, 41);
    getColWidthsMap(doc, sheetId).set(c1, 90);

    expect(deleteRows(doc, sheetId, [r1])).toBe(true);
    expect(readRowOrder(doc, sheetId)).toEqual(rows.filter((id) => id !== r1));
    expect([...getCellsMap(doc, sheetId).keys()]).toEqual([cellKey(r0, c1)]);
    expect([...getFormatsMap(doc, sheetId).keys()]).toEqual([cellKey(r0, c0)]);
    expect([...getRowHeightsMap(doc, sheetId).keys()]).toEqual([r2]);

    expect(deleteCols(doc, sheetId, [c1])).toBe(true);
    expect(readColOrder(doc, sheetId)).toEqual(cols.filter((id) => id !== c1));
    expect(getCellsMap(doc, sheetId).size).toBe(0);
    expect(getColWidthsMap(doc, sheetId).size).toBe(0);
  });

  it("removes every raw occurrence of a duplicated id", () => {
    const { doc, sheetId } = single();
    const order = getRowOrderArray(doc, sheetId);
    const r0 = order.get(0);
    order.insert(5, [r0]);
    expect(deleteRows(doc, sheetId, [r0])).toBe(true);
    expect(order.toArray()).not.toContain(r0);
  });

  it("refuses to delete every row or column, and unknown ids, writing nothing", () => {
    const { doc, sheetId } = single();
    expect(deleteRows(doc, sheetId, readRowOrder(doc, sheetId))).toBe(false);
    expect(deleteCols(doc, sheetId, readColOrder(doc, sheetId))).toBe(false);
    expect(deleteRows(doc, sheetId, ["nope"])).toBe(false);
    expect(readRowOrder(doc, sheetId)).toHaveLength(100);
    expect(readColOrder(doc, sheetId)).toHaveLength(26);
  });
});

describe("structure ops under concurrency", () => {
  it("(a) a row inserted above a row another client is editing keeps the edit on its row", () => {
    const { a, b, sheetId, sync } = createPair();
    const row5 = readRowOrder(a, sheetId)[4] as string;
    const colB = readColOrder(a, sheetId)[1] as string;
    const [inserted] = insertRows(a, sheetId, 4, 1) as string[];
    setCell(b, sheetId, row5, colB, { v: "B's value" });
    sync();
    for (const doc of [a, b]) {
      const rows = readRowOrder(doc, sheetId);
      expect(rows[4]).toBe(inserted);
      expect(rows[5]).toBe(row5);
      expect(getCell(doc, sheetId, rows[5] as string, colB)).toEqual({ v: "B's value" });
      expect(getCell(doc, sheetId, rows[4] as string, colB)).toBeUndefined();
    }
  });

  it("(b) two clients inserting at the same index both keep their rows, in one shared order", () => {
    const { a, b, sheetId, sync } = createPair();
    const idA = (insertRows(a, sheetId, 2, 1) as string[])[0] as string;
    const idB = (insertRows(b, sheetId, 2, 1) as string[])[0] as string;
    sync();
    const orderA = readRowOrder(a, sheetId);
    expect(orderA).toHaveLength(102);
    expect(orderA).toContain(idA);
    expect(orderA).toContain(idB);
    expect(readRowOrder(b, sheetId)).toEqual(orderA);
    expect(Math.abs(orderA.indexOf(idA) - orderA.indexOf(idB))).toBe(1);
  });

  it("(c) a cell written into a row another client deleted is orphaned; undo of the delete restores the row", () => {
    const { a, b, sheetId, sync } = createPair();
    const rows = readRowOrder(a, sheetId);
    const row3 = rows[2] as string;
    const colA = readColOrder(a, sheetId)[0] as string;
    const colB = readColOrder(a, sheetId)[1] as string;
    setCell(a, sheetId, row3, colA, { v: "orig" });
    sync();

    const undo = new Y.UndoManager(getSheetsMap(a), { trackedOrigins: new Set(["local"]) });
    a.transact(() => {
      deleteRows(a, sheetId, [row3]);
    }, "local");
    // Concurrent: B writes a brand-new cell and overwrites the existing one in the doomed row.
    setCell(b, sheetId, row3, colB, { v: "from B" });
    setCell(b, sheetId, row3, colA, { v: "B overwrote" });
    sync();

    for (const doc of [a, b]) {
      expect(readRowOrder(doc, sheetId)).not.toContain(row3);
      expect(readRowOrder(doc, sheetId)).toHaveLength(99);
      // Orphan entries may exist in the map; readers ignore ids that are in no order array.
      const visible = new Set(readRowOrder(doc, sheetId));
      const seen = [...getCellsMap(doc, sheetId).keys()].filter((k) =>
        visible.has(k.split(":")[0] as string),
      );
      expect(seen).toEqual([]);
    }
    const orphansBefore = [...getCellsMap(a, sheetId).keys()].sort();
    expect(orphansBefore).toEqual([cellKey(row3, colA), cellKey(row3, colB)].sort());

    undo.undo();
    sync();
    for (const doc of [a, b]) {
      expect(readRowOrder(doc, sheetId)[2]).toBe(row3);
      expect(readRowOrder(doc, sheetId)).toHaveLength(100);
      // What Yjs actually does: B's concurrent writes survive; they were not A's to undo,
      // and the redo of A's deletion of the old "orig" item does not beat B's newer item.
      expect(getCell(doc, sheetId, row3, colB)).toEqual({ v: "from B" });
      expect(getCell(doc, sheetId, row3, colA)).toEqual({ v: "B overwrote" });
    }
  });

  it("(c2) undo of a delete restores the deleted row's own cells and formats", () => {
    const { doc, sheetId } = single();
    const row3 = readRowOrder(doc, sheetId)[2] as string;
    const colA = readColOrder(doc, sheetId)[0] as string;
    setCell(doc, sheetId, row3, colA, { v: "keep me" });
    getFormatsMap(doc, sheetId).set(cellKey(row3, colA), { b: true });
    const undo = new Y.UndoManager(getSheetsMap(doc), { trackedOrigins: new Set(["local"]) });
    doc.transact(() => {
      deleteRows(doc, sheetId, [row3]);
    }, "local");
    expect(getCell(doc, sheetId, row3, colA)).toBeUndefined();
    undo.undo();
    expect(readRowOrder(doc, sheetId)[2]).toBe(row3);
    expect(getCell(doc, sheetId, row3, colA)).toEqual({ v: "keep me" });
    expect(getFormatsMap(doc, sheetId).get(cellKey(row3, colA))).toEqual({ b: true });
  });

  it("works on a second sheet too", () => {
    const { doc } = single();
    const s2 = addSheet(doc, "Other");
    const [id] = insertRows(doc, s2, 0, 1) as string[];
    expect(readRowOrder(doc, s2)[0]).toBe(id);
  });
});
