import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  colIndexToLabel,
  colLabelToIndex,
  createSheetNameIndex,
  decodeFormula,
  encodeFormula,
  formatSheetPrefix,
  quoteSheetName,
  referencedSheetIds,
  type DecodeContext,
  type EncodeContext,
  type IdLookup,
  type IdResolver,
} from "./formula-refs.js";

const identity: IdResolver = { rowId: (i) => `r${i}`, colId: (j) => `c${j}` };
const identityLookup: IdLookup = {
  rowIndex: (id) => (/^r\d+$/.test(id) ? Number(id.slice(1)) : undefined),
  colIndex: (id) => (/^c\d+$/.test(id) ? Number(id.slice(1)) : undefined),
};

// Sheets known to the tests: id -> name. Every sheet shares the identity row/col ids,
// except "s9", whose ids are prefixed so per-sheet resolution is observable.
const SHEETS: Record<string, string> = {
  s1: "Sheet1",
  s2: "Sheet2",
  s3: "My Sheet",
  s4: "it's",
  s5: "A1",
  s6: "Data.v2",
  s9: "Other",
};
const sheetResolver = (sheetId: string): IdResolver =>
  sheetId === "s9" ? { rowId: (i) => `x${i}`, colId: (j) => `y${j}` } : identity;
const sheetLookup = (sheetId: string): IdLookup | undefined => {
  if (!(sheetId in SHEETS)) return undefined;
  if (sheetId === "s9") {
    return {
      rowIndex: (id) => (/^x\d+$/.test(id) ? Number(id.slice(1)) : undefined),
      colIndex: (id) => (/^y\d+$/.test(id) ? Number(id.slice(1)) : undefined),
    };
  }
  return identityLookup;
};
const enc: EncodeContext = {
  sheetId: "s1",
  sheetIdByName: createSheetNameIndex(Object.entries(SHEETS).map(([id, name]) => ({ id, name }))),
  resolver: sheetResolver,
};
const dec: DecodeContext = {
  sheetId: "s1",
  lookup: sheetLookup,
  sheetPrefix: (id) => formatSheetPrefix(SHEETS[id] ?? id),
};
const engineDec: DecodeContext = {
  ...dec,
  sheetPrefix: (id) => formatSheetPrefix(id, { alwaysQuote: true }),
};
const withOwn = (own: IdLookup): DecodeContext => ({
  ...dec,
  lookup: (id) => (id === "s1" ? own : sheetLookup(id)),
});

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
    expect(encodeFormula(input, enc)).toBe(expected);
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
    ["=Nope!A1", "unknown sheet kept verbatim"],
    ["='No Such'!A1:B2", "unknown quoted sheet kept verbatim"],
    ['="Sheet2!A1"', "sheet ref inside a string"],
    ['="it\'s"&"x"', "apostrophe inside a double-quoted string"],
    ["=Sheet2!Foo", "not a reference after the prefix"],
    ["=1+2.5*3", "numbers"],
    ["=TRUE", "boolean"],
    ["=IF(FALSE,1,2)", "boolean"],
    ["=A", "bare letter"],
    ["=5", "bare number"],
    ["=XFE1", "column out of range"],
    ["=A1048577", "row out of range"],
    ["=A0", "row zero"],
  ])("leaves %s untouched (%s)", (input) => {
    expect(encodeFormula(input, enc)).toBe(input);
  });

  it("encodes refs next to strings but not inside them", () => {
    expect(encodeFormula('=A1&"A1"&B1', enc)).toBe('=[[r:r0,c:c0]]&"A1"&[[r:r0,c:c1]]');
  });
});

describe("decodeFormula", () => {
  it("round-trips the hand-picked cases", () => {
    for (const f of ["=A1", "=$A$1", "=SUM(A:C)", "=SUM(2:5)", "=SUM(A1:B3)", '="A1"&C4']) {
      expect(decodeFormula(encodeFormula(f, enc), dec)).toBe(f);
    }
  });

  it("uppercases column letters", () => {
    expect(decodeFormula(encodeFormula("=a1+b$2", enc), dec)).toBe("=A1+B$2");
  });

  it("turns refs to deleted rows or columns into #REF!", () => {
    const stored = encodeFormula("=A1+B2", enc);
    const noRow0: IdLookup = {
      ...identityLookup,
      rowIndex: (id) => (id === "r0" ? undefined : identityLookup.rowIndex(id)),
    };
    const noCol1: IdLookup = {
      ...identityLookup,
      colIndex: (id) => (id === "c1" ? undefined : identityLookup.colIndex(id)),
    };
    expect(decodeFormula(stored, withOwn(noRow0))).toBe("=#REF!+B2");
    expect(decodeFormula(stored, withOwn(noCol1))).toBe("=A1+#REF!");
  });

  it("turns a whole range into one #REF! if any endpoint is gone", () => {
    const stored = encodeFormula("=SUM(A1:C3)+SUM(A:C)", enc);
    const noCol2: IdLookup = {
      ...identityLookup,
      colIndex: (id) => (id === "c2" ? undefined : identityLookup.colIndex(id)),
    };
    expect(decodeFormula(stored, withOwn(noCol2))).toBe("=SUM(#REF!)+SUM(#REF!)");
  });

  it("leaves token-looking text inside string literals alone", () => {
    expect(decodeFormula('="[[r:r0,c:c0]]"', dec)).toBe('="[[r:r0,c:c0]]"');
  });

  it("renumbers when the lookup shifts indices", () => {
    const shifted: IdLookup = {
      rowIndex: (id) => identityLookup.rowIndex(id)! + 1,
      colIndex: identityLookup.colIndex,
    };
    expect(decodeFormula("=[[r:r0,c:c0]]", withOwn(shifted))).toBe("=A2");
  });
});

describe("sheet-qualified references", () => {
  it.each([
    ["=Sheet2!A1", "=[[s:s2,r:r0,c:c0]]"],
    ["=sheet2!b3", "=[[s:s2,r:r2,c:c1]]"],
    ["=SHEET2!$B$3", "=[[s:s2,$r:r2,$c:c1]]"],
    ["='My Sheet'!A1", "=[[s:s3,r:r0,c:c0]]"],
    ["='my sheet'!A1", "=[[s:s3,r:r0,c:c0]]"],
    ["='it''s'!A1", "=[[s:s4,r:r0,c:c0]]"],
    ["='A1'!B2", "=[[s:s5,r:r1,c:c1]]"],
    ["=Data.v2!C1", "=[[s:s6,r:r0,c:c2]]"],
    ["=Sheet1!A1", "=[[s:s1,r:r0,c:c0]]"],
    ["=Sheet2!A1:B3", "=[[s:s2,r:r0,c:c0]]:[[r:r2,c:c1]]"],
    ["=SUM('My Sheet'!A:C)", "=SUM([[s:s3,c:c0]]:[[c:c2]])"],
    ["=SUM(Sheet2!2:5)", "=SUM([[s:s2,r:r1]]:[[r:r4]])"],
    ["=Sheet2!A1+A1", "=[[s:s2,r:r0,c:c0]]+[[r:r0,c:c0]]"],
    ["=Other!B2", "=[[s:s9,r:x1,c:y1]]"],
    ["=LOG10(Sheet2!A1)", "=LOG10([[s:s2,r:r0,c:c0]])"],
  ])("encodes %s", (input, expected) => {
    expect(encodeFormula(input, enc)).toBe(expected);
  });

  it("does not treat a quoted sheet name followed by ! as a string literal", () => {
    expect(encodeFormula("='My Sheet'!A1&\"x\"", enc)).toBe('=[[s:s3,r:r0,c:c0]]&"x"');
  });

  it("decodes sheet names for display, quoting only when needed", () => {
    const f = (a1: string) => decodeFormula(encodeFormula(a1, enc), dec);
    expect(f("=Sheet2!A1")).toBe("=Sheet2!A1");
    expect(f("=sheet2!a1")).toBe("=Sheet2!A1");
    expect(f("=Sheet1!A1")).toBe("=Sheet1!A1");
    expect(f("='My Sheet'!A1:B3")).toBe("='My Sheet'!A1:B3");
    expect(f("='it''s'!A1")).toBe("='it''s'!A1");
    expect(f("='A1'!B2")).toBe("='A1'!B2");
    expect(f("=Data.v2!C1")).toBe("=Data.v2!C1");
    expect(f("=SUM(Sheet2!A:C)")).toBe("=SUM(Sheet2!A:C)");
    expect(f("=SUM(Sheet2!2:5)")).toBe("=SUM(Sheet2!2:5)");
    expect(f("=Other!B2")).toBe("=Other!B2");
  });

  it("decodes in engine mode with the sheet id always quoted", () => {
    const stored = encodeFormula("=Sheet2!A1:B3+A1+SUM('My Sheet'!C:C)", enc);
    expect(decodeFormula(stored, engineDec)).toBe("='s2'!A1:B3+A1+SUM('s3'!C:C)");
  });

  it("follows a renamed sheet because ids are stored", () => {
    const stored = encodeFormula("=Sheet2!A1", enc);
    expect(decodeFormula(stored, { ...dec, sheetPrefix: () => "Budget!" })).toBe("=Budget!A1");
  });

  it("turns refs to a deleted sheet into #REF!, whole ranges included", () => {
    const stored = encodeFormula("=Sheet2!A1+SUM(Sheet2!A1:B3)+B1", enc);
    const noS2: DecodeContext = {
      ...dec,
      lookup: (id) => (id === "s2" ? undefined : sheetLookup(id)),
    };
    expect(decodeFormula(stored, noS2)).toBe("=#REF!+SUM(#REF!)+B1");
  });

  it("turns a deleted row or column in another sheet into #REF!", () => {
    const stored = encodeFormula("=Sheet2!A1+Sheet2!B2+B2", enc);
    const noRow0: DecodeContext = {
      ...dec,
      lookup: (id) =>
        id === "s2"
          ? {
              ...identityLookup,
              rowIndex: (r) => (r === "r0" ? undefined : identityLookup.rowIndex(r)),
            }
          : sheetLookup(id),
    };
    expect(decodeFormula(stored, noRow0)).toBe("=#REF!+Sheet2!B2+B2");
  });

  it("resolves rows and columns per sheet", () => {
    const stored = encodeFormula("=Other!A1+A1", enc);
    expect(stored).toBe("=[[s:s9,r:x0,c:y0]]+[[r:r0,c:c0]]");
    expect(decodeFormula(stored, dec)).toBe("=Other!A1+A1");
  });

  it("accepts a matching s: on the second range token and rejects a different one", () => {
    expect(decodeFormula("=[[s:s2,r:r0,c:c0]]:[[s:s2,r:r2,c:c1]]", dec)).toBe("=Sheet2!A1:B3");
    expect(decodeFormula("=[[s:s2,r:r0,c:c0]]:[[s:s3,r:r2,c:c1]]", dec)).toBe("=#REF!");
  });

  it("decodes own-sheet s: tokens with a prefix and plain tokens without", () => {
    expect(decodeFormula("=[[s:s1,r:r0,c:c0]]+[[r:r0,c:c0]]", dec)).toBe("=Sheet1!A1+A1");
  });

  it("quotes names that need it", () => {
    for (const name of [
      "A1",
      "AB",
      "R1C1",
      "RC",
      "TRUE",
      "false",
      "1abc",
      "a b",
      "x-y",
      "é",
      "it's",
    ]) {
      expect(formatSheetPrefix(name)).toBe(`'${name.replaceAll("'", "''")}'!`);
    }
    for (const name of ["Sheet1", "Data.v2", "_x", "Budget", "ABCD1"]) {
      expect(quoteSheetName(name)).toBe(name);
    }
    expect(quoteSheetName("Sheet1", true)).toBe("'Sheet1'");
  });

  it("lists referenced sheet ids, skipping string literals", () => {
    const stored = '=[[s:s2,r:r0,c:c0]]+SUM([[s:s3,c:c0]]:[[c:c1]])&"[[s:s9,r:r0]]"+[[r:r0,c:c0]]';
    expect(referencedSheetIds(stored)).toEqual(new Set(["s2", "s3"]));
    expect(referencedSheetIds("=[[r:r0,c:c0]]")).toEqual(new Set());
  });

  it("createSheetNameIndex matches case-insensitively, first sheet wins", () => {
    const find = createSheetNameIndex([
      { id: "a", name: "Data" },
      { id: "b", name: "DATA" },
    ]);
    expect(find("dAtA")).toBe("a");
    expect(find("nope")).toBeUndefined();
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
// Random sheet names, many needing quotes; ids are q0..q{n-1} for the n generated names.
const nameCharArb = fc.constantFrom(..."abcXYZ019_. -'!:é");
const sheetNameArb = fc
  .array(nameCharArb, { minLength: 1, maxLength: 8 })
  .map((cs) => cs.join(""))
  .filter((n) => n.trim() === n && !n.startsWith("'") && !n.endsWith("'"));
const sheetNamesArb = fc.uniqueArray(sheetNameArb, {
  minLength: 1,
  maxLength: 4,
  selector: (n) => n.toLowerCase(),
});
const qualifiedArb = fc.tuple(
  fc.nat(3),
  fc.boolean(),
  fc.oneof(cellArb, cellRangeArb, colRangeArb, rowRangeArb),
);

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
      "Nope!A1",
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
        expect(decodeFormula(encodeFormula(src, enc), dec)).toBe(out);
      }),
    );
  });

  it("leaves no A1 references outside string literals after encoding", () => {
    fc.assert(
      fc.property(formulaArb, ({ src }) => {
        const encoded = encodeFormula(src, enc)
          .replace(STRING, '""')
          .replace(TOKEN, "")
          // Refs to unknown sheets are kept verbatim by design.
          .replaceAll("Nope!A1", "");
        expect(encoded).not.toMatch(LEFTOVER_REF);
      }),
    );
  });

  it("round-trips with ids that look like A1 refs or function names", () => {
    const tricky: IdResolver = { rowId: (i) => `A${i}`, colId: (j) => `LOG10_${j}` };
    const trickyEnc: EncodeContext = { ...enc, resolver: () => tricky };
    const trickyLookup: IdLookup = {
      rowIndex: (id) => (/^A\d+$/.test(id) ? Number(id.slice(1)) : undefined),
      colIndex: (id) => (/^LOG10_\d+$/.test(id) ? Number(id.slice(6)) : undefined),
    };
    fc.assert(
      fc.property(formulaArb, ({ src, out }) => {
        expect(
          decodeFormula(encodeFormula(src, trickyEnc), { ...dec, lookup: () => trickyLookup }),
        ).toBe(out);
      }),
    );
  });

  it("round-trips sheet-qualified refs with random names, case-insensitively", () => {
    fc.assert(
      fc.property(
        sheetNamesArb,
        fc.array(qualifiedArb, { minLength: 1, maxLength: 4 }),
        (names, parts) => {
          const sheets = names.map((name, i) => ({ id: `q${i}`, name }));
          const e: EncodeContext = {
            sheetId: "q0",
            sheetIdByName: createSheetNameIndex(sheets),
            resolver: () => identity,
          };
          const d: DecodeContext = {
            sheetId: "q0",
            lookup: () => identityLookup,
            sheetPrefix: (id) => formatSheetPrefix(sheets.find((s) => s.id === id)!.name),
          };
          const src: string[] = [];
          const out: string[] = [];
          for (const [n, upperName, seg] of parts) {
            const sheet = sheets[n % sheets.length]!;
            const typed = upperName ? sheet.name.toUpperCase() : sheet.name;
            src.push(`${quoteSheetName(typed, true)}!${seg.src}`);
            out.push(`${formatSheetPrefix(sheet.name)}${seg.out}`);
          }
          // The unquoted spelling too, when the name allows it.
          const plain = sheets.find((s) => quoteSheetName(s.name) === s.name);
          if (plain) {
            src.push(`${plain.name.toLowerCase()}!A1`);
            out.push(`${formatSheetPrefix(plain.name)}A1`);
          }
          const stored = encodeFormula(`=${src.join("+")}`, e);
          expect(decodeFormula(stored, d)).toBe(`=${out.join("+")}`);
          const engine = decodeFormula(stored, {
            ...d,
            sheetPrefix: (id) => formatSheetPrefix(id, { alwaysQuote: true }),
          });
          expect(engine).not.toContain("#REF!");
          expect(engine).toMatch(/'q\d'!/);
        },
      ),
    );
  });
});
