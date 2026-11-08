import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  getSheetName,
  isSheetHidden,
  readSheetOrder,
  setSheetHidden as hideInDoc,
} from "@worksheet-clone/shared";
import { newDoc } from "../test-utils/workbook";
import { LOCAL_ORIGIN } from "./origin";
import { addSheet, deleteSheet, moveSheet, renameSheet, setSheetHidden } from "./mutations";

/** Counts transactions that changed the doc and the updates they emitted. */
function watch(doc: Y.Doc) {
  const origins: unknown[] = [];
  let updates = 0;
  doc.on("update", () => updates++);
  doc.on("afterTransaction", (tx: Y.Transaction) => {
    if (tx.changed.size > 0) origins.push(tx.origin);
  });
  return {
    origins,
    get updates() {
      return updates;
    },
  };
}

describe("sheet mutations", () => {
  it("addSheet uses the next default name, goes after the given sheet, in one transaction", () => {
    const { doc, sheetId } = newDoc();
    const w = watch(doc);
    const id = addSheet(doc, false, sheetId);
    expect(id).not.toBeNull();
    expect(getSheetName(doc, id!)).toBe("Sheet2");
    expect(readSheetOrder(doc)).toEqual([sheetId, id]);
    const third = addSheet(doc, false, sheetId)!;
    expect(readSheetOrder(doc)).toEqual([sheetId, third, id]);
    expect(w.updates).toBe(2);
    expect(w.origins).toEqual([LOCAL_ORIGIN, LOCAL_ORIGIN]);
  });

  it("addSheet is refused while read-only", () => {
    const { doc } = newDoc();
    const w = watch(doc);
    expect(addSheet(doc, true)).toBeNull();
    expect(w.updates).toBe(0);
  });

  describe("renameSheet", () => {
    it("trims and writes in one transaction", () => {
      const { doc, sheetId } = newDoc();
      const w = watch(doc);
      expect(renameSheet(doc, false, sheetId, "  Budget ")).toEqual({ ok: true });
      expect(getSheetName(doc, sheetId)).toBe("Budget");
      expect(w.updates).toBe(1);
      expect(w.origins).toEqual([LOCAL_ORIGIN]);
    });

    it("treats an unchanged name as success without writing", () => {
      const { doc, sheetId } = newDoc();
      const w = watch(doc);
      expect(renameSheet(doc, false, sheetId, " Sheet1 ")).toEqual({ ok: true });
      expect(w.updates).toBe(0);
    });

    it("allows changing only the case of its own name", () => {
      const { doc, sheetId } = newDoc();
      expect(renameSheet(doc, false, sheetId, "SHEET1")).toEqual({ ok: true });
      expect(getSheetName(doc, sheetId)).toBe("SHEET1");
    });

    it("refuses names taken by another sheet, ignoring case and hidden ones", () => {
      const { doc, sheetId } = newDoc();
      const other = addSheet(doc, false)!;
      hideInDoc(doc, other, true);
      const w = watch(doc);
      const result = renameSheet(doc, false, sheetId, "sheet2");
      expect(result).toEqual({ ok: false, error: 'A sheet named "sheet2" already exists' });
      expect(w.updates).toBe(0);
    });

    it("refuses empty, invalid and read-only renames without writing", () => {
      const { doc, sheetId } = newDoc();
      const w = watch(doc);
      expect(renameSheet(doc, false, sheetId, "   ").ok).toBe(false);
      expect(renameSheet(doc, false, sheetId, "a:b").ok).toBe(false);
      expect(renameSheet(doc, false, sheetId, "x".repeat(101)).ok).toBe(false);
      expect(renameSheet(doc, true, sheetId, "Nope").ok).toBe(false);
      expect(renameSheet(doc, false, "missing", "Nope").ok).toBe(false);
      expect(w.updates).toBe(0);
      expect(getSheetName(doc, sheetId)).toBe("Sheet1");
    });
  });

  describe("setSheetHidden", () => {
    it("hides and unhides in one transaction each", () => {
      const { doc, sheetId } = newDoc();
      const other = addSheet(doc, false)!;
      const w = watch(doc);
      expect(setSheetHidden(doc, false, other, true)).toBe(true);
      expect(isSheetHidden(doc, other)).toBe(true);
      expect(setSheetHidden(doc, false, other, false)).toBe(true);
      expect(isSheetHidden(doc, other)).toBe(false);
      expect(w.updates).toBe(2);
      expect(w.origins).toEqual([LOCAL_ORIGIN, LOCAL_ORIGIN]);
      expect(isSheetHidden(doc, sheetId)).toBe(false);
    });

    it("refuses hiding the last visible sheet, and read-only", () => {
      const { doc, sheetId } = newDoc();
      const w = watch(doc);
      expect(setSheetHidden(doc, false, sheetId, true)).toBe(false);
      const other = addSheet(doc, false)!;
      const before = w.updates;
      expect(setSheetHidden(doc, true, other, true)).toBe(false);
      expect(setSheetHidden(doc, false, other, true)).toBe(true);
      expect(setSheetHidden(doc, false, sheetId, true)).toBe(false);
      expect(w.updates).toBe(before + 1);
    });
  });

  describe("deleteSheet", () => {
    it("deletes in one transaction", () => {
      const { doc, sheetId } = newDoc();
      const other = addSheet(doc, false)!;
      const w = watch(doc);
      expect(deleteSheet(doc, false, other)).toBe(true);
      expect(readSheetOrder(doc)).toEqual([sheetId]);
      expect(w.updates).toBe(1);
      expect(w.origins).toEqual([LOCAL_ORIGIN]);
    });

    it("refuses deleting the last visible sheet even when hidden ones remain", () => {
      const { doc, sheetId } = newDoc();
      expect(deleteSheet(doc, false, sheetId)).toBe(false);
      const other = addSheet(doc, false)!;
      hideInDoc(doc, other, true);
      expect(deleteSheet(doc, false, sheetId)).toBe(false);
      expect(readSheetOrder(doc)).toEqual([sheetId, other]);
    });

    it("can delete a hidden sheet, and refuses while read-only", () => {
      const { doc, sheetId } = newDoc();
      const other = addSheet(doc, false)!;
      hideInDoc(doc, other, true);
      expect(deleteSheet(doc, true, other)).toBe(false);
      expect(deleteSheet(doc, false, other)).toBe(true);
      expect(readSheetOrder(doc)).toEqual([sheetId]);
    });
  });

  describe("moveSheet", () => {
    it("reorders in one transaction", () => {
      const { doc, sheetId } = newDoc();
      const b = addSheet(doc, false)!;
      const c = addSheet(doc, false)!;
      const w = watch(doc);
      expect(moveSheet(doc, false, c, 0)).toBe(true);
      expect(readSheetOrder(doc)).toEqual([c, sheetId, b]);
      expect(w.updates).toBe(1);
      expect(w.origins).toEqual([LOCAL_ORIGIN]);
    });

    it("refuses while read-only or for an unknown sheet", () => {
      const { doc, sheetId } = newDoc();
      addSheet(doc, false);
      const w = watch(doc);
      expect(moveSheet(doc, true, sheetId, 1)).toBe(false);
      expect(moveSheet(doc, false, "missing", 1)).toBe(false);
      expect(w.updates).toBe(0);
    });
  });
});
