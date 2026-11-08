import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseTsv, serializeTsv } from "./tsv";

describe("serializeTsv", () => {
  it("joins cells with tabs and rows with newlines", () => {
    expect(serializeTsv([["a", "b"], ["c"]])).toBe("a\tb\nc");
  });
  it("quotes cells with tab, newline or quote and doubles quotes", () => {
    expect(serializeTsv([["a\tb", 'say "hi"', "x\ny"]])).toBe('"a\tb"\t"say ""hi"""\t"x\ny"');
  });
  it("keeps a trailing empty single-cell row", () => {
    expect(parseTsv(serializeTsv([["a"], [""]]))).toEqual([["a"], [""]]);
  });
});

describe("parseTsv", () => {
  it("parses tabs and newlines, accepting \\r\\n", () => {
    expect(parseTsv("a\tb\r\nc\td")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
  it("ignores one trailing newline but not two", () => {
    expect(parseTsv("a\tb\n")).toEqual([["a", "b"]]);
    expect(parseTsv("a\n\n")).toEqual([["a"], [""]]);
    expect(parseTsv("a\r\n")).toEqual([["a"]]);
  });
  it("handles quoted cells with embedded newlines, tabs and quotes", () => {
    expect(parseTsv('"a\nb"\t"c\td"\t"say ""hi"""')).toEqual([["a\nb", "c\td", 'say "hi"']]);
  });
  it("treats a mid-cell quote as literal", () => {
    expect(parseTsv('5" pipe\tx')).toEqual([['5" pipe', "x"]]);
  });
  it("pads ragged rows to the widest", () => {
    expect(parseTsv("a\tb\tc\nd")).toEqual([
      ["a", "b", "c"],
      ["d", "", ""],
    ]);
  });
  it("reads empty text as one empty cell", () => {
    expect(parseTsv("")).toEqual([[""]]);
  });
  it("round-trips arbitrary rectangular grids", () => {
    const cell = fc.string({ unit: fc.constantFrom("a", "b", "\t", "\n", "\r", '"', " ", "1") });
    const grid = fc
      .tuple(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 }))
      .chain(([r, c]) =>
        fc.array(fc.array(cell, { minLength: c, maxLength: c }), { minLength: r, maxLength: r }),
      );
    fc.assert(
      fc.property(grid, (rows) => {
        expect(parseTsv(serializeTsv(rows))).toEqual(rows);
      }),
    );
  });
  it("round-trips fully arbitrary strings", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: "binary" }), { minLength: 1, maxLength: 5 }),
        (cells) => {
          expect(parseTsv(serializeTsv([cells]))).toEqual([cells]);
        },
      ),
    );
  });
});
