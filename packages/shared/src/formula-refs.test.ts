import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  colIndexToLabel,
  colLabelToIndex,
  decodeFormula,
  encodeFormula,
  type IdLookup,
  type IdResolver,
} from "./formula-refs.js";

const identity: IdResolver = { rowId: (i) => `r${i}`, colId: (j) => `c${j}` };
const identityLookup: IdLookup = {
  rowIndex: (id) => (/^r\d+$/.test(id) ? Number(id.slice(1)) : undefined),
  colIndex: (id) => (/^c\d+$/.test(id) ? Number(id.slice(1)) : undefined),
};

describe("column labels", () => {
  it.each([
    [0, "A"],
    [25, "Z"],
    [26, "AA"],
    [51, "AZ"],
    [52, "BA"],
    [701, "ZZ"],
    [702, "AAA"],
    [16383, "XFD"],
  ])("%i <-> %s", (index, label) => {
    expect(colIndexToLabel(index)).toBe(label);
    expect(colLabelToIndex(label)).toBe(index);
  });

  it("parses labels case-insensitively", () => {
    expect(colLabelToIndex("xfd")).toBe(16383);
    expect(colLabelToIndex("aB")).toBe(27);
  });
});

describe("encodeFormula", () => {
  it.each([
    ["=A1", "=[[r:r0,c:c0]]"],
    ["=a1", "=[[r:r0,c:c0]]"],
    ["=$A$1", "=[[$r:r0,$c:c0]]"],
    ["=$A1", "=[[r:r0,$c:c0]]"],
    ["=A$1", "=[[$r:r0,c:c0]]"],
    ["=B3+1", "=[[r:r2,c:c1]]+1"],
    ["=SUM(A1:A3)", "=SUM([[r:r0,c:c0]]:[[r:r2,c:c0]])"],
    ["=SUM($A$1:B$3)", "=SUM([[$r:r0,$c:c0]]:[[$r:r2,c:c1]])"],
    ["=SUM(A:C)", "=SUM([[c:c0]]:[[c:c2]])"],
    ["=SUM($A:$A)", "=SUM([[$c:c0]]:[[$c:c0]])"],
    ["=SUM(2:5)", "=SUM([[r:r1]]:[[r:r4]])"],
    ["=SUM($2:$5)", "=SUM([[$r:r1]]:[[$r:r4]])"],
    ["=XFD1048576", "=[[r:r1048575,c:c16383]]"],
  ])("%s", (input, expected) => {
    expect(encodeFormula(input, identity)).toBe(expected);
  });

  it.each([
    ['="A1"', "string literal"],
    ['="say ""A1"" now"', "escaped quotes"],
    ['=IF(A1="B2",1,2)'.replace("A1", "x"), "string compared"],
    ["=LOG10(5)", "function with digits"],
    ["=ATAN2(1,2)", "function with digits"],
    ["=LOG10 (5)".replace(" ", ""), "no space"],
    ["=ABC1D", "longer identifier"],
    ["=A1B", "ref-like prefix"],
    ["=ABCD1", "four letters"],
    ["=Sheet2!A1", "sheet-qualified"],
    ["=Sheet2!A1:B2", "sheet-qualified range"],
    ["='My Sheet'!A1", "quoted sheet"],
    ["=1+2.5*3", "numbers"],
    ["=TRUE", "boolean"],
    ["=IF(FALSE,1,2)", "boolean"],
    ["=A", "bare letter"],
    ["=5", "bare number"],
    ["=XFE1", "column out of range"],
    ["=A1048577", "row out of range"],
    ["=A0", "row zero"],
  ])("leaves %s untouched (%s)", (input) => {
    expect(encodeFormula(input, identity)).toBe(input);
  });

  it("encodes refs next to strings but not inside them", () => {
    expect(encodeFormula('=A1&"A1"&B1', identity)).toBe('=[[r:r0,c:c0]]&"A1"&[[r:r0,c:c1]]');
  });
});

describe("decodeFormula", () => {
  it("round-trips the hand-picked cases", () => {
    for (const f of ["=A1", "=$A$1", "=SUM(A:C)", "=SUM(2:5)", "=SUM(A1:B3)", '="A1"&C4']) {
      expect(decodeFormula(encodeFormula(f, identity), identityLookup)).toBe(f);
    }
  });

  it("uppercases column letters", () => {
    expect(decodeFormula(encodeFormula("=a1+b$2", identity), identityLookup)).toBe("=A1+B$2");
  });

  it("turns refs to deleted rows or columns into #REF!", () => {
    const stored = encodeFormula("=A1+B2", identity);
    const noRow0: IdLookup = {
      ...identityLookup,
      rowIndex: (id) => (id === "r0" ? undefined : identityLookup.rowIndex(id)),
    };
    const noCol1: IdLookup = {
      ...identityLookup,
      colIndex: (id) => (id === "c1" ? undefined : identityLookup.colIndex(id)),
    };
    expect(decodeFormula(stored, noRow0)).toBe("=#REF!+B2");
    expect(decodeFormula(stored, noCol1)).toBe("=A1+#REF!");
  });

  it("turns a whole range into one #REF! if any endpoint is gone", () => {
    const stored = encodeFormula("=SUM(A1:C3)+SUM(A:C)", identity);
    const noCol2: IdLookup = {
      ...identityLookup,
      colIndex: (id) => (id === "c2" ? undefined : identityLookup.colIndex(id)),
    };
    expect(decodeFormula(stored, noCol2)).toBe("=SUM(#REF!)+SUM(#REF!)");
  });

  it("leaves token-looking text inside string literals alone", () => {
    expect(decodeFormula('="[[r:r0,c:c0]]"', identityLookup)).toBe('="[[r:r0,c:c0]]"');
  });

  it("renumbers when the lookup shifts indices", () => {
    const shifted: IdLookup = {
      rowIndex: (id) => identityLookup.rowIndex(id)! + 1,
      colIndex: identityLookup.colIndex,
    };
    expect(decodeFormula("=[[r:r0,c:c0]]", shifted)).toBe("=A2");
  });
});

// Generators: each segment carries its source text and the text expected back.
const upper = (s: string): string => s.toUpperCase();
const caseOf = (s: string, lower: boolean): string => (lower ? s.toLowerCase() : s);
const colArb = fc.integer({ min: 0, max: 16383 });
const rowArb = fc.integer({ min: 1, max: 1048576 });
const flagArb = fc.boolean();

const cellArb = fc.tuple(colArb, rowArb, flagArb, flagArb, flagArb).map(([c, r, ca, ra, lower]) => {
  const src = `${ca ? "$" : ""}${caseOf(colIndexToLabel(c), lower)}${ra ? "$" : ""}${r}`;
  return { src, out: upper(src) };
});
const cellRangeArb = fc
  .tuple(cellArb, cellArb)
  .map(([a, b]) => ({ src: `${a.src}:${b.src}`, out: `${a.out}:${b.out}` }));
const colRangeArb = fc
  .tuple(colArb, colArb, flagArb, flagArb, flagArb)
  .map(([a, b, fa, fb, lower]) => {
    const src = `${fa ? "$" : ""}${caseOf(colIndexToLabel(a), lower)}:${fb ? "$" : ""}${caseOf(colIndexToLabel(b), lower)}`;
    return { src, out: upper(src) };
  });
const rowRangeArb = fc.tuple(rowArb, rowArb, flagArb, flagArb).map(([a, b, fa, fb]) => {
  const src = `${fa ? "$" : ""}${a}:${fb ? "$" : ""}${b}`;
  return { src, out: src };
});
const plainArb = fc
  .oneof(
    fc.constantFrom(
      "SUM(",
      "LOG10(",
      "ATAN2(",
      "IF(",
      "if(",
      ")",
      ",",
      "+",
      "-",
      "*",
      "/",
      "&",
      "=",
      "<>",
      "TRUE",
      "FALSE",
      "Sheet2!A1",
      "ABC1D",
      "A1B",
    ),
    fc.double({ min: 0, max: 1000, noNaN: true }).map((n) => String(n)),
    fc.integer({ min: 0, max: 99999 }).map(String),
  )
  .map((s) => ({ src: s, out: s }));
const literalArb = fc
  .array(fc.constantFrom("A1", "$B$2", "SUM(A1:A3)", " ", ":", '""', "x", "!", "[[r:r0,c:c0]]"), {
    maxLength: 5,
  })
  .map((parts) => {
    const s = `"${parts.join("")}"`;
    return { src: s, out: s };
  });

const formulaArb = fc
  .array(fc.oneof(cellArb, cellRangeArb, colRangeArb, rowRangeArb, plainArb, literalArb), {
    minLength: 1,
    maxLength: 12,
  })
  .map((segs) => ({
    src: `=${segs.map((s) => s.src).join(" ")}`,
    out: `=${segs.map((s) => s.out).join(" ")}`,
  }));

const TOKEN = /\[\[[^\]]*\]\]/g;
const STRING = /"(?:[^"]|"")*"/g;
const LEFTOVER_REF =
  /(?<![A-Za-z0-9_.$!])\$?[A-Za-z]{1,3}\$?\d+(?![A-Za-z0-9_(])|(?<![A-Za-z0-9_.$!])\$?\d+:\$?\d+/;

describe("formula codec properties", () => {
  it("decode(encode(f)) equals f with column letters uppercased", () => {
    fc.assert(
      fc.property(formulaArb, ({ src, out }) => {
        expect(decodeFormula(encodeFormula(src, identity), identityLookup)).toBe(out);
      }),
    );
  });

  it("leaves no A1 references outside string literals after encoding", () => {
    fc.assert(
      fc.property(formulaArb, ({ src }) => {
        const encoded = encodeFormula(src, identity)
          .replace(STRING, '""')
          .replace(TOKEN, "")
          // Sheet-qualified refs are deliberately untouched until M5.
          .replaceAll("Sheet2!A1", "");
        expect(encoded).not.toMatch(LEFTOVER_REF);
      }),
    );
  });

  it("round-trips with ids that look like A1 refs or function names", () => {
    const tricky: IdResolver = { rowId: (i) => `A${i}`, colId: (j) => `LOG10_${j}` };
    const trickyLookup: IdLookup = {
      rowIndex: (id) => (/^A\d+$/.test(id) ? Number(id.slice(1)) : undefined),
      colIndex: (id) => (/^LOG10_\d+$/.test(id) ? Number(id.slice(6)) : undefined),
    };
    fc.assert(
      fc.property(formulaArb, ({ src, out }) => {
        expect(decodeFormula(encodeFormula(src, tricky), trickyLookup)).toBe(out);
      }),
    );
  });
});
