import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addSheet,
  createEmptyWorkbook,
  deleteSheet,
  ensureWorkbookHasSheet,
  getSheetName,
  getSheetOrderArray,
  getSheetsMap,
  hasOtherVisibleSheet,
  isSheetNameTaken,
  moveSheet,
  nextSheetName,
  readSheetOrder,
  readVisibleSheetOrder,
  setSheetHidden,
  sheetNameSchema,
} from "./index.js";

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

/** A workbook with sheets named by ids: Sheet1 = s1, then the given extra ids. */
function workbook(...extra: string[]): Y.Doc {
  const doc = new Y.Doc();
  createEmptyWorkbook(doc);
  const first = readSheetOrder(doc)[0]!;
  // Make ids predictable.
  doc.transact(() => {
    deleteSheet(doc, first);
    addSheet(doc, "Sheet1", { sheetId: "s1" });
    for (const id of extra) addSheet(doc, id.toUpperCase(), { sheetId: id });
  });
  return doc;
}

function fork(doc: Y.Doc): [Y.Doc, Y.Doc] {
  const a = new Y.Doc();
  const b = new Y.Doc();
  Y.applyUpdate(a, Y.encodeStateAsUpdate(doc));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(doc));
  return [a, b];
}

describe("sheetNameSchema", () => {
  it("trims and accepts ordinary names", () => {
    expect(sheetNameSchema.parse("  Budget 2026 ")).toBe("Budget 2026");
    expect(sheetNameSchema.parse("it's fine")).toBe("it's fine");
    expect(sheetNameSchema.parse("a".repeat(100))).toHaveLength(100);
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["a".repeat(101), "too long"],
    ["a[b", "["],
    ["a]b", "]"],
    ["a*b", "*"],
    ["a?b", "?"],
    ["a/b", "/"],
    ["a\\b", "\\"],
    ["a:b", ":"],
    ["'quoted", "leading apostrophe"],
    ["quoted'", "trailing apostrophe"],
  ])("rejects %j (%s) with a readable message", (name) => {
    const result = sheetNameSchema.safeParse(name);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/^Sheet name /);
  });
});

describe("names", () => {
  it("isSheetNameTaken ignores case, counts hidden sheets and honors the exception", () => {
    const doc = workbook("s2");
    setSheetHidden(doc, "s2", true);
    expect(isSheetNameTaken(doc, "sheet1")).toBe(true);
    expect(isSheetNameTaken(doc, "S2")).toBe(true);
    expect(isSheetNameTaken(doc, "S3")).toBe(false);
    expect(isSheetNameTaken(doc, "sheet1", "s1")).toBe(false);
  });

  it("nextSheetName picks the smallest free number", () => {
    const doc = workbook();
    expect(nextSheetName(doc)).toBe("Sheet2");
    addSheet(doc, "sheet3");
    expect(nextSheetName(doc)).toBe("Sheet2");
    addSheet(doc, "Sheet2");
    expect(nextSheetName(doc)).toBe("Sheet4");
  });
});

describe("addSheet", () => {
  it("appends by default and inserts after a given sheet", () => {
    const doc = workbook("s2", "s3");
    addSheet(doc, "Mid", { afterSheetId: "s1", sheetId: "m" });
    addSheet(doc, "End", { afterSheetId: "s3", sheetId: "e" });
    addSheet(doc, "Unknown", { afterSheetId: "nope", sheetId: "u" });
    expect(readSheetOrder(doc)).toEqual(["s1", "m", "s2", "s3", "e", "u"]);
  });

  it("still accepts a bare sheet id", () => {
    const doc = workbook();
    expect(addSheet(doc, "Legacy", "legacy")).toBe("legacy");
    expect(readSheetOrder(doc)).toEqual(["s1", "legacy"]);
  });
});

describe("hide, delete and visibility", () => {
  it("setSheetHidden and readVisibleSheetOrder", () => {
    const doc = workbook("s2", "s3");
    setSheetHidden(doc, "s2", true);
    expect(readVisibleSheetOrder(doc)).toEqual(["s1", "s3"]);
    setSheetHidden(doc, "s2", false);
    expect(readVisibleSheetOrder(doc)).toEqual(["s1", "s2", "s3"]);
  });

  it("deleteSheet removes the sheet and every occurrence from the order", () => {
    const doc = workbook("s2");
    getSheetOrderArray(doc).push(["s2"]); // a duplicate left by concurrent moves
    deleteSheet(doc, "s2");
    expect(getSheetsMap(doc).has("s2")).toBe(false);
    expect(getSheetOrderArray(doc).toArray()).toEqual(["s1"]);
  });

  it("hasOtherVisibleSheet is false when the sheet is the only visible one", () => {
    const doc = workbook("s2", "s3");
    expect(hasOtherVisibleSheet(doc, "s1")).toBe(true);
    setSheetHidden(doc, "s2", true);
    setSheetHidden(doc, "s3", true);
    expect(hasOtherVisibleSheet(doc, "s1")).toBe(false);
    expect(hasOtherVisibleSheet(doc, "s2")).toBe(true);
  });

  it("concurrent hides of every sheet leave the first one visible (read rule only)", () => {
    const [a, b] = fork(workbook("s2"));
    setSheetHidden(a, "s1", true);
    setSheetHidden(b, "s2", true);
    sync(a, b);
    for (const doc of [a, b]) {
      expect(readVisibleSheetOrder(doc)).toEqual(["s1"]);
      // Nothing was written: both sheets are still flagged hidden.
      expect(getSheetsMap(doc).get("s1")?.get("hidden")).toBe(true);
      expect(getSheetsMap(doc).get("s2")?.get("hidden")).toBe(true);
    }
  });

  it("readVisibleSheetOrder is empty only when there are no sheets", () => {
    const doc = new Y.Doc();
    expect(readVisibleSheetOrder(doc)).toEqual([]);
  });
});

describe("moveSheet", () => {
  it.each([
    ["s1", 2, ["s2", "s3", "s1", "s4"]],
    ["s1", 3, ["s2", "s3", "s4", "s1"]],
    ["s4", 0, ["s4", "s1", "s2", "s3"]],
    ["s3", 1, ["s1", "s3", "s2", "s4"]],
    ["s2", 1, ["s1", "s2", "s3", "s4"]],
    ["s2", 99, ["s1", "s3", "s4", "s2"]],
    ["s3", -5, ["s3", "s1", "s2", "s4"]],
  ])("moves %s to index %i", (id, toIndex, expected) => {
    const doc = workbook("s2", "s3", "s4");
    moveSheet(doc, id, toIndex);
    expect(readSheetOrder(doc)).toEqual(expected);
    expect(
      getSheetOrderArray(doc)
        .toArray()
        .filter((x) => x === id),
    ).toHaveLength(1);
  });

  it("uses visible-order indices even with duplicates and dangling ids in the raw order", () => {
    const doc = workbook("s2", "s3");
    getSheetOrderArray(doc).insert(0, ["ghost", "s2"]);
    expect(readSheetOrder(doc)).toEqual(["s2", "s1", "s3"]);
    moveSheet(doc, "s3", 1);
    expect(readSheetOrder(doc)).toEqual(["s2", "s3", "s1"]);
  });

  it("converges when two peers move the same sheet concurrently, without duplicates on read", () => {
    const [a, b] = fork(workbook("s2", "s3", "s4"));
    moveSheet(a, "s1", 3);
    moveSheet(b, "s1", 1);
    sync(a, b);
    expect(readSheetOrder(a)).toEqual(readSheetOrder(b));
    expect(readSheetOrder(a)).toHaveLength(4);
    expect(new Set(readSheetOrder(a)).size).toBe(4);
  });

  it("converges when two peers move different sheets concurrently", () => {
    const [a, b] = fork(workbook("s2", "s3", "s4"));
    moveSheet(a, "s1", 3);
    moveSheet(b, "s4", 0);
    sync(a, b);
    expect(readSheetOrder(a)).toEqual(readSheetOrder(b));
    expect(new Set(readSheetOrder(a)).size).toBe(4);
  });
});

describe("ensureWorkbookHasSheet", () => {
  it("does nothing for an uninitialized doc or one that has sheets", () => {
    expect(ensureWorkbookHasSheet(new Y.Doc())).toBe(false);
    const doc = workbook();
    expect(ensureWorkbookHasSheet(doc)).toBe(false);
    expect(readSheetOrder(doc)).toEqual(["s1"]);
  });

  it("adds one sheet in one transaction when none is left, and is idempotent", () => {
    const doc = workbook();
    deleteSheet(doc, "s1");
    let transactions = 0;
    doc.on("afterTransaction", () => transactions++);
    expect(ensureWorkbookHasSheet(doc)).toBe(true);
    expect(transactions).toBe(1);
    const [id] = readSheetOrder(doc);
    expect(readSheetOrder(doc)).toHaveLength(1);
    expect(getSheetName(doc, id!)).toBe("Sheet1");
    expect(ensureWorkbookHasSheet(doc)).toBe(false);
  });

  it("repairs the state left by two peers deleting the last two sheets concurrently", () => {
    const [a, b] = fork(workbook("s2"));
    deleteSheet(a, "s1");
    deleteSheet(b, "s2");
    sync(a, b);
    expect(readSheetOrder(a)).toEqual([]);
    // Only the "server" repairs; clients must not.
    expect(ensureWorkbookHasSheet(a)).toBe(true);
    sync(a, b);
    expect(readSheetOrder(a)).toHaveLength(1);
    expect(readSheetOrder(b)).toEqual(readSheetOrder(a));
    expect(ensureWorkbookHasSheet(b)).toBe(false);
  });
});
