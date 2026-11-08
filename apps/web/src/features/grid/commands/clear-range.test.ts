import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  getCell,
  getFormatsMap,
  cellKey,
  readColOrder,
  readRowOrder,
} from "@worksheet-clone/shared";
import { LOCAL_ORIGIN } from "../../../crdt/origin";
import { edit, newDoc } from "../../../test-utils/workbook";
import { clearRange } from "./clear-range";

function model(doc: Y.Doc, sheetId: string) {
  const rows = readRowOrder(doc, sheetId);
  const cols = readColOrder(doc, sheetId);
  return { rowIdAt: (i: number) => rows[i], colIdAt: (j: number) => cols[j], rows, cols };
}

function transactionOrigins(doc: Y.Doc): unknown[] {
  const origins: unknown[] = [];
  doc.on("afterTransaction", (tr: Y.Transaction) => origins.push(tr.origin));
  return origins;
}

const range = { start: { row: 0, col: 0 }, end: { row: 1, col: 2 } };

describe("clearRange", () => {
  it("deletes contents in one LOCAL_ORIGIN transaction and leaves formats", () => {
    const { doc, sheetId } = newDoc();
    const m = model(doc, sheetId);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) edit(doc, sheetId, r, c, { v: 1 });
    doc.transact(() =>
      getFormatsMap(doc, sheetId).set(cellKey(m.rows[0]!, m.cols[0]!), { b: true }),
    );
    const origins = transactionOrigins(doc);

    expect(clearRange({ doc, readOnly: false }, sheetId, range, m)).toBe(true);

    expect(origins).toEqual([LOCAL_ORIGIN]);
    expect(getCell(doc, sheetId, m.rows[0]!, m.cols[0]!)).toBeUndefined();
    expect(getCell(doc, sheetId, m.rows[1]!, m.cols[2]!)).toBeUndefined();
    expect(getCell(doc, sheetId, m.rows[2]!, m.cols[0]!)).toEqual({ v: 1 });
    expect(getCell(doc, sheetId, m.rows[0]!, m.cols[2]!)).toBeUndefined();
    expect(getFormatsMap(doc, sheetId).get(cellKey(m.rows[0]!, m.cols[0]!))).toEqual({ b: true });
  });

  it("refuses while read-only: nothing changes and no transaction runs", () => {
    const { doc, sheetId } = newDoc();
    const m = model(doc, sheetId);
    edit(doc, sheetId, 0, 0, { v: 1 });
    const origins = transactionOrigins(doc);
    expect(clearRange({ doc, readOnly: true }, sheetId, range, m)).toBe(false);
    expect(origins).toHaveLength(0);
    expect(getCell(doc, sheetId, m.rows[0]!, m.cols[0]!)).toEqual({ v: 1 });
  });

  it("ignores indices outside the grid", () => {
    const { doc, sheetId } = newDoc();
    const m = model(doc, sheetId);
    const origins = transactionOrigins(doc);
    const outside = { start: { row: 500, col: 500 }, end: { row: 501, col: 501 } };
    expect(clearRange({ doc, readOnly: false }, sheetId, outside, m)).toBe(false);
    expect(origins).toHaveLength(0);
  });
});
