import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addSheet,
  createEmptyWorkbook,
  encodeFormula,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  setCell,
  setSheetName,
} from "@worksheet-clone/shared";
import { recoveryFiles, sheetRows, toCsv } from "./recovery-csv";

function workbook() {
  const doc = new Y.Doc();
  createEmptyWorkbook(doc);
  const sheetId = readSheetOrder(doc)[0] ?? "";
  const rows = readRowOrder(doc, sheetId);
  const cols = readColOrder(doc, sheetId);
  const put = (r: number, c: number, data: Parameters<typeof setCell>[4]) =>
    setCell(doc, sheetId, rows[r] ?? "", cols[c] ?? "", data);
  const formula = (a1: string) =>
    encodeFormula(a1, {
      sheetId,
      sheetIdByName: () => undefined,
      resolver: () => ({ rowId: (i) => rows[i] ?? "", colId: (i) => cols[i] ?? "" }),
    });
  return { doc, sheetId, put, formula };
}

// Written as an escape: a literal BOM in source is invisible (and the linter rejects it).
const BOM = String.fromCharCode(0xfeff);

describe("toCsv", () => {
  it("quotes fields with commas, quotes and line breaks, and ends rows with CRLF", () => {
    expect(
      toCsv([
        ["a", "b,c", 'say "hi"', "two\nlines"],
        ["", "x"],
      ]),
    ).toBe('a,"b,c","say ""hi""","two\nlines"\r\n,x\r\n');
  });

  it("is empty for no rows", () => {
    expect(toCsv([])).toBe("");
  });
});

describe("sheetRows", () => {
  it("trims to the used range and writes formulas as A1 text, booleans as TRUE/FALSE", () => {
    const { doc, sheetId, put, formula } = workbook();
    put(0, 0, { v: 5 });
    put(1, 0, { f: formula("=A1*2") });
    put(1, 2, { v: true });
    put(2, 1, { v: "007" });
    expect(sheetRows(doc, sheetId)).toEqual([
      ["5", "", ""],
      ["=A1*2", "", "TRUE"],
      ["", "007", ""],
    ]);
  });

  it("is empty for a sheet without content, and ignores cells of deleted rows", () => {
    const { doc, sheetId, put } = workbook();
    expect(sheetRows(doc, sheetId)).toEqual([]);
    put(3, 3, { v: "x" });
    const rowOrder = doc.getMap<Y.Map<unknown>>("sheets").get(sheetId)?.get("rowOrder") as
      Y.Array<string> | undefined;
    rowOrder?.delete(3, 1);
    expect(sheetRows(doc, sheetId)).toEqual([]);
  });
});

describe("recoveryFiles", () => {
  it("makes one BOM-prefixed UTF-8 CSV per non-empty sheet, named workbook - sheet", () => {
    const { doc, put } = workbook();
    put(0, 0, { v: "héllo, wörld" });
    addSheet(doc, "Empty");
    const files = recoveryFiles(doc, "Q3 budget");
    expect(files).toEqual([
      { fileName: "Q3 budget - Sheet1.csv", content: `${BOM}"héllo, wörld"\r\n` },
    ]);
  });

  it("replaces characters a file name cannot hold and keeps duplicate names apart", () => {
    const { doc, sheetId, put } = workbook();
    put(0, 0, { v: 1 });
    setSheetName(doc, sheetId, "a/b");
    const other = addSheet(doc, "a:b");
    setCell(doc, other, readRowOrder(doc, other)[0] ?? "", readColOrder(doc, other)[0] ?? "", {
      v: 2,
    });
    expect(recoveryFiles(doc, 'Plan: "v2"').map((f) => f.fileName)).toEqual([
      "Plan_ _v2_ - a_b.csv",
      "Plan_ _v2_ - a_b (2).csv",
    ]);
  });
});
