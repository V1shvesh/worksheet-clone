import { describe, expect, it } from "vitest";
import fc from "fast-check";
import * as Y from "yjs";
import {
  addSheet,
  createEmptyWorkbook,
  getCell,
  getSheetName,
  getSheetsMap,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  setCell,
} from "./doc-schema.js";
import {
  createSheetNameIndex,
  decodeFormula,
  encodeFormula,
  formatSheetPrefix,
  retargetDeleted,
  type DecodeContext,
  type EncodeContext,
} from "./formula-refs.js";
import { deleteCols, deleteRows } from "./structure.js";

// A workbook with Sheet1 and Data; formulas are typed in A1 and stored id-based.
function setup() {
  const doc = new Y.Doc();
  createEmptyWorkbook(doc);
  const s1 = readSheetOrder(doc)[0] as string;
  const data = addSheet(doc, "Data");
  const names = () =>
    createSheetNameIndex(
      [...getSheetsMap(doc).keys()].map((id) => ({ id, name: getSheetName(doc, id) ?? "" })),
    );
  const encodeCtx = (sheetId: string): EncodeContext => ({
    sheetId,
    sheetIdByName: names(),
    resolver: (id) => ({
      rowId: (i) => readRowOrder(doc, id)[i] as string,
      colId: (j) => readColOrder(doc, id)[j] as string,
    }),
  });
  const decodeCtx = (sheetId: string): DecodeContext => ({
    sheetId,
    lookup: (id) => {
      if (!getSheetsMap(doc).has(id)) return undefined;
      const rows = readRowOrder(doc, id);
      const cols = readColOrder(doc, id);
      return {
        rowIndex: (r) => (rows.includes(r) ? rows.indexOf(r) : undefined),
        colIndex: (c) => (cols.includes(c) ? cols.indexOf(c) : undefined),
      };
    },
    sheetPrefix: (id) => formatSheetPrefix(getSheetName(doc, id) ?? id),
  });
  // Put a formula at the given cell of a sheet.
  const put = (sheetId: string, row: number, col: number, a1: string) => {
    setCell(
      doc,
      sheetId,
      readRowOrder(doc, sheetId)[row] as string,
      readColOrder(doc, sheetId)[col] as string,
      {
        f: encodeFormula(a1, encodeCtx(sheetId)),
      },
    );
  };
  const read = (sheetId: string, row: number, col: number) => {
    const cell = getCell(
      doc,
      sheetId,
      readRowOrder(doc, sheetId)[row] as string,
      readColOrder(doc, sheetId)[col] as string,
    );
    return cell?.f === undefined ? undefined : decodeFormula(cell.f, decodeCtx(sheetId));
  };
  const rowId = (sheetId: string, i: number) => readRowOrder(doc, sheetId)[i] as string;
  const colId = (sheetId: string, i: number) => readColOrder(doc, sheetId)[i] as string;
  return { doc, s1, data, put, read, rowId, colId };
}

describe("deleteRows / deleteCols rewrite formulas", () => {
  it("shrinks a range when its last row is deleted", () => {
    const t = setup();
    t.put(t.s1, 0, 5, "=SUM(A1:A3)");
    t.doc.transact(() => deleteRows(t.doc, t.s1, [t.rowId(t.s1, 2)]));
    expect(t.read(t.s1, 0, 5)).toBe("=SUM(A1:A2)");
  });

  it("moves the first endpoint to the next surviving row", () => {
    const t = setup();
    t.put(t.s1, 9, 5, "=SUM(A1:A3)");
    t.doc.transact(() => deleteRows(t.doc, t.s1, [t.rowId(t.s1, 0)]));
    // The old A2:A3 is now A1:A2.
    expect(t.read(t.s1, 8, 5)).toBe("=SUM(A1:A2)");
  });

  it("gives #REF! when every row of the range is deleted", () => {
    const t = setup();
    t.put(t.s1, 9, 5, "=SUM(A1:A3)");
    t.doc.transact(() =>
      deleteRows(
        t.doc,
        t.s1,
        [0, 1, 2].map((i) => t.rowId(t.s1, i)),
      ),
    );
    expect(t.read(t.s1, 6, 5)).toBe("=SUM(#REF!)");
  });

  it("leaves a range alone when a middle row goes (it shrinks by itself)", () => {
    const t = setup();
    t.put(t.s1, 0, 5, "=SUM(A1:A3)");
    const f = getCell(t.doc, t.s1, t.rowId(t.s1, 0), t.colId(t.s1, 5))?.f;
    t.doc.transact(() => deleteRows(t.doc, t.s1, [t.rowId(t.s1, 1)]));
    expect(getCell(t.doc, t.s1, t.rowId(t.s1, 0), t.colId(t.s1, 5))?.f).toBe(f);
    expect(t.read(t.s1, 0, 5)).toBe("=SUM(A1:A2)");
  });

  it("shrinks column ranges, whole-column ranges and keeps $ flags", () => {
    const t = setup();
    t.put(t.s1, 5, 0, "=SUM(A1:C1)");
    t.put(t.s1, 6, 0, "=SUM(A:C)");
    t.put(t.s1, 7, 0, "=SUM($A$1:$C$3)");
    t.doc.transact(() => deleteCols(t.doc, t.s1, [t.colId(t.s1, 2)]));
    expect(t.read(t.s1, 5, 0)).toBe("=SUM(A1:B1)");
    expect(t.read(t.s1, 6, 0)).toBe("=SUM(A:B)");
    expect(t.read(t.s1, 7, 0)).toBe("=SUM($A$1:$B$3)");
  });

  it("keeps $ on a moved endpoint", () => {
    const t = setup();
    t.put(t.s1, 9, 5, "=SUM($A$1:$A$3)");
    t.doc.transact(() => deleteRows(t.doc, t.s1, [t.rowId(t.s1, 2)]));
    expect(t.read(t.s1, 8, 5)).toBe("=SUM($A$1:$A$2)");
  });

  it("rewrites whole-row ranges", () => {
    const t = setup();
    t.put(t.s1, 9, 5, "=SUM(1:3)");
    t.doc.transact(() => deleteRows(t.doc, t.s1, [t.rowId(t.s1, 0)]));
    expect(t.read(t.s1, 8, 5)).toBe("=SUM(1:2)");
  });

  it("rewrites cross-sheet ranges from another sheet", () => {
    const t = setup();
    t.put(t.s1, 0, 0, "=SUM(Data!A1:A3)+SUM(A1:A3)");
    t.doc.transact(() => deleteRows(t.doc, t.data, [t.rowId(t.data, 2)]));
    // Only the range into Data shrinks; the own-sheet range is unaffected.
    expect(t.read(t.s1, 0, 0)).toBe("=SUM(Data!A1:A2)+SUM(A1:A3)");
  });

  it("leaves ranges on other sheets alone when the deleted row ids are on this sheet only", () => {
    const t = setup();
    t.put(t.data, 0, 0, "=SUM(A1:A3)");
    t.doc.transact(() => deleteRows(t.doc, t.s1, [t.rowId(t.s1, 2)]));
    expect(t.read(t.data, 0, 0)).toBe("=SUM(A1:A3)");
  });

  it("shrinks a range and turns a single ref to a deleted cell into #REF! in one formula", () => {
    const t = setup();
    t.put(t.s1, 0, 5, "=A3+SUM(A1:A3)+B1");
    t.doc.transact(() => deleteRows(t.doc, t.s1, [t.rowId(t.s1, 2)]));
    expect(t.read(t.s1, 0, 5)).toBe("=#REF!+SUM(A1:A2)+B1");
  });

  it("does not touch string literals", () => {
    const t = setup();
    t.put(t.s1, 0, 5, '="A1:A3"&SUM(A1:A3)');
    t.doc.transact(() => deleteRows(t.doc, t.s1, [t.rowId(t.s1, 2)]));
    expect(t.read(t.s1, 0, 5)).toBe('="A1:A3"&SUM(A1:A2)');
  });

  it("handles a reversed range", () => {
    const t = setup();
    t.put(t.s1, 9, 5, "=SUM(A3:A1)");
    t.doc.transact(() => deleteRows(t.doc, t.s1, [t.rowId(t.s1, 2)]));
    expect(t.read(t.s1, 8, 5)).toBe("=SUM(A2:A1)");
  });

  it("writes nothing when the delete is refused", () => {
    const t = setup();
    t.put(t.s1, 0, 5, "=SUM(A1:A3)");
    const before = Y.encodeStateAsUpdate(t.doc);
    expect(deleteRows(t.doc, t.s1, readRowOrder(t.doc, t.s1))).toBe(false);
    expect(Y.encodeStateAsUpdate(t.doc)).toEqual(before);
  });
});

describe("retargetDeleted property: Excel's rule on indices", () => {
  const N = 12;
  const ids = Array.from({ length: N }, (_, i) => `r${i}`);
  const noCols = { rows: [] as string[], cols: [] as string[] };

  it("matches the reference model for random ranges and deletions", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: N - 1 }),
        fc.integer({ min: 0, max: N - 1 }),
        fc.uniqueArray(fc.integer({ min: 0, max: N - 1 }), { maxLength: N - 1 }),
        (a, b, deletedIdx) => {
          const deleted = new Set(deletedIdx);
          const stored = `=SUM([[r:r${a},c:c0]]:[[r:r${b},c:c0]])`;
          const out = retargetDeleted(stored, {
            sheetId: "s1",
            deletedRows: new Map([["s1", new Set(deletedIdx.map((i) => `r${i}`))]]),
            deletedCols: new Map(),
            orderOf: () => ({ ...noCols, rows: ids, cols: ["c0"] }),
          });
          const after = ids.filter((_, i) => !deleted.has(i));
          const decoded = decodeFormula(out, {
            sheetId: "s1",
            lookup: () => ({
              rowIndex: (id) => (after.includes(id) ? after.indexOf(id) : undefined),
              colIndex: (id) => (id === "c0" ? 0 : undefined),
            }),
            sheetPrefix: () => "",
          });
          // Reference model: surviving rows inside the range, renumbered.
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const survivors = ids
            .map((_, i) => i)
            .filter((i) => i >= lo && i <= hi && !deleted.has(i));
          const renumber = (i: number) => i - deletedIdx.filter((d) => d < i).length;
          let expected: string;
          if (survivors.length === 0) {
            expected = "=SUM(#REF!)";
          } else {
            const first = renumber(survivors[0] as number) + 1;
            const last = renumber(survivors.at(-1) as number) + 1;
            expected = a <= b ? `=SUM(A${first}:A${last})` : `=SUM(A${last}:A${first})`;
          }
          expect(decoded).toBe(expected);
        },
      ),
      { numRuns: 500 },
    );
  });
});
