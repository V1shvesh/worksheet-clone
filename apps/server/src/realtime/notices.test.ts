import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addSheet,
  createEmptyWorkbook,
  readSheetOrder,
  setSheetName,
} from "@worksheet-clone/shared";
import { diffSheetNames, readSheetNames } from "./notices.js";

describe("diffSheetNames", () => {
  it("reports renamed sheets only", () => {
    const before = new Map([
      ["a", "Sheet1"],
      ["b", "Sheet2"],
      ["gone", "Old"],
    ]);
    const after = new Map([
      ["a", "Sheet1"],
      ["b", "Budget"],
      ["new", "Added"],
    ]);
    expect(diffSheetNames(before, after)).toEqual([{ sheetId: "b", from: "Sheet2", to: "Budget" }]);
  });

  it("reports several renames and nothing when unchanged", () => {
    const before = new Map([
      ["a", "x"],
      ["b", "y"],
    ]);
    expect(diffSheetNames(before, before)).toEqual([]);
    expect(
      diffSheetNames(
        before,
        new Map([
          ["a", "x2"],
          ["b", "y2"],
        ]),
      ).map((r) => r.sheetId),
    ).toEqual(["a", "b"]);
  });
});

describe("readSheetNames", () => {
  it("reads names of all sheets in order", () => {
    const doc = new Y.Doc();
    createEmptyWorkbook(doc);
    const second = addSheet(doc, "Second");
    const [first = ""] = readSheetOrder(doc);
    setSheetName(doc, first, "First");
    expect([...readSheetNames(doc)]).toEqual([
      [first, "First"],
      [second, "Second"],
    ]);
  });
});
