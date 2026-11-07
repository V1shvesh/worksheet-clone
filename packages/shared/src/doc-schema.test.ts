import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addSheet,
  createEmptyWorkbook,
  DEFAULT_SHEET_NAME,
  getCell,
  getRowOrderArray,
  getSchemaVersion,
  getSheetName,
  getSheetOrderArray,
  isWorkbookInitialized,
  readRowOrder,
  readSheetOrder,
  SCHEMA_VERSION,
  setCell,
  setSheetName,
} from "./doc-schema.js";

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

// Two peers that both start from the server-created state.
function forkedPair(): [Y.Doc, Y.Doc, string] {
  const server = new Y.Doc();
  createEmptyWorkbook(server);
  const a = new Y.Doc();
  const b = new Y.Doc();
  Y.applyUpdate(a, Y.encodeStateAsUpdate(server));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(server));
  const [sheetId] = readSheetOrder(a);
  if (!sheetId) throw new Error("no sheet");
  return [a, b, sheetId];
}

describe("createEmptyWorkbook", () => {
  it("creates one sheet and stamps the schema version in one transaction", () => {
    const doc = new Y.Doc();
    expect(isWorkbookInitialized(doc)).toBe(false);

    let transactions = 0;
    doc.on("afterTransaction", () => transactions++);
    createEmptyWorkbook(doc);

    expect(transactions).toBe(1);
    expect(isWorkbookInitialized(doc)).toBe(true);
    expect(getSchemaVersion(doc)).toBe(SCHEMA_VERSION);
    const order = readSheetOrder(doc);
    expect(order).toHaveLength(1);
    expect(getSheetName(doc, order[0] ?? "")).toBe(DEFAULT_SHEET_NAME);
  });
});

describe("cells", () => {
  it("sets, reads and clears cells by row/col id", () => {
    const [doc, , sheetId] = forkedPair();

    setCell(doc, sheetId, "r1", "c1", { v: 42 });
    expect(getCell(doc, sheetId, "r1", "c1")).toEqual({ v: 42 });

    setCell(doc, sheetId, "r1", "c1", {});
    expect(getCell(doc, sheetId, "r1", "c1")).toBeUndefined();
  });

  it("rejects writes to an unknown sheet", () => {
    const [doc] = forkedPair();
    expect(() => setCell(doc, "nope", "r1", "c1", { v: 1 })).toThrow("Unknown sheet nope");
  });
});

describe("concurrent edits converge", () => {
  it("merges a sheet rename and a cell edit made at the same time", () => {
    const [a, b, sheetId] = forkedPair();

    setSheetName(a, sheetId, "Budget");
    setCell(b, sheetId, "r1", "c1", { v: "hello" });
    sync(a, b);

    for (const doc of [a, b]) {
      expect(getSheetName(doc, sheetId)).toBe("Budget");
      expect(getCell(doc, sheetId, "r1", "c1")).toEqual({ v: "hello" });
    }
  });

  it("resolves conflicting writes to the same cell identically on both peers", () => {
    const [a, b, sheetId] = forkedPair();

    setCell(a, sheetId, "r1", "c1", { v: "from a" });
    setCell(b, sheetId, "r1", "c1", { v: "from b" });
    sync(a, b);

    expect(getCell(a, sheetId, "r1", "c1")).toEqual(getCell(b, sheetId, "r1", "c1"));
  });

  it("keeps sheets added concurrently by different peers", () => {
    const [a, b] = forkedPair();

    addSheet(a, "From A");
    addSheet(b, "From B");
    sync(a, b);

    expect(readSheetOrder(a)).toEqual(readSheetOrder(b));
    expect(readSheetOrder(a)).toHaveLength(3);
  });

  it("de-duplicates an id that a concurrent move left in the order twice", () => {
    const [a, b, sheetId] = forkedPair();
    getRowOrderArray(a, sheetId).push(["r1", "r2"]);
    sync(a, b);

    // Both peers "move" r1 to the end: delete + insert, concurrently.
    for (const doc of [a, b]) {
      doc.transact(() => {
        const rows = getRowOrderArray(doc, sheetId);
        rows.delete(0, 1);
        rows.push(["r1"]);
      });
    }
    sync(a, b);

    expect(getRowOrderArray(a, sheetId).toArray()).toEqual(["r2", "r1", "r1"]);
    expect(readRowOrder(a, sheetId)).toEqual(["r2", "r1"]);
    expect(readRowOrder(b, sheetId)).toEqual(readRowOrder(a, sheetId));
  });

  it("ignores sheet ids in the order whose sheet no longer exists", () => {
    const [doc] = forkedPair();
    getSheetOrderArray(doc).push(["ghost"]);
    expect(readSheetOrder(doc)).toHaveLength(1);
  });
});
