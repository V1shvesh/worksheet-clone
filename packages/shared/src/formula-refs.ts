// Formulas are stored with id-based references so they survive concurrent
// row/column inserts and deletes (PROJECT_CONTEXT §3.1), and are translated
// to A1 for display and for HyperFormula.
//
// Stored tokens: [[r:ROW,c:COL]] cell, [[c:COL]] whole column, [[r:ROW]] whole
// row; a "$" before r/c marks that axis absolute; ranges join two tokens
// with ":".

export interface IdResolver {
  /** 0-based row index to row id. May create ids; the codec stays pure. */
  rowId(index: number): string;
  colId(index: number): string;
}

export interface IdLookup {
  /** Undefined when the row/column no longer exists. */
  rowIndex(id: string): number | undefined;
  colIndex(id: string): number | undefined;
}

const MAX_COL_INDEX = 16383; // XFD
const MAX_ROW = 1048576;
const REF_ERROR = "#REF!";

export function colIndexToLabel(index: number): string {
  let label = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

export function colLabelToIndex(label: string): number {
  let n = 0;
  for (const ch of label.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

interface Axis {
  abs: boolean;
  index: number;
}

const CELL = String.raw`(\$?)([A-Za-z]{1,3})(\$?)(\d+)`;
const COL = String.raw`(\$?)([A-Za-z]{1,3})`;
const ROW = String.raw`(\$?)(\d+)`;
const CELL_RANGE_RE = new RegExp(`${CELL}(?::${CELL})?`, "y");
const COL_RANGE_RE = new RegExp(`${COL}:${COL}`, "y");
const ROW_RANGE_RE = new RegExp(`${ROW}:${ROW}`, "y");
const IDENT_CHAR = /[A-Za-z0-9_.$]/;

function validCol(label: string): number | undefined {
  const index = colLabelToIndex(label);
  return index <= MAX_COL_INDEX ? index : undefined;
}
function validRow(digits: string): number | undefined {
  const row = Number(digits);
  return row >= 1 && row <= MAX_ROW ? row - 1 : undefined;
}

function cellToken(r: Axis, c: Axis, resolve: IdResolver): string {
  return `[[${r.abs ? "$" : ""}r:${resolve.rowId(r.index)},${c.abs ? "$" : ""}c:${resolve.colId(c.index)}]]`;
}
function colToken(c: Axis, resolve: IdResolver): string {
  return `[[${c.abs ? "$" : ""}c:${resolve.colId(c.index)}]]`;
}
function rowToken(r: Axis, resolve: IdResolver): string {
  return `[[${r.abs ? "$" : ""}r:${resolve.rowId(r.index)}]]`;
}

/** Tries to read a reference at `pos`; returns its encoding and length. */
function matchRef(
  src: string,
  pos: number,
  resolve: IdResolver,
): { text: string; length: number } | undefined {
  CELL_RANGE_RE.lastIndex = pos;
  const cell = CELL_RANGE_RE.exec(src);
  if (cell) {
    const col1 = validCol(cell[2] ?? "");
    const row1 = validRow(cell[4] ?? "");
    if (col1 !== undefined && row1 !== undefined) {
      const a = cellToken(
        { abs: cell[3] === "$", index: row1 },
        { abs: cell[1] === "$", index: col1 },
        resolve,
      );
      if (cell[6] === undefined) return { text: a, length: cell[0].length };
      const col2 = validCol(cell[6]);
      const row2 = validRow(cell[8] ?? "");
      if (col2 !== undefined && row2 !== undefined) {
        const b = cellToken(
          { abs: cell[7] === "$", index: row2 },
          { abs: cell[5] === "$", index: col2 },
          resolve,
        );
        return { text: `${a}:${b}`, length: cell[0].length };
      }
    }
    return undefined;
  }

  COL_RANGE_RE.lastIndex = pos;
  const cols = COL_RANGE_RE.exec(src);
  if (cols) {
    const c1 = validCol(cols[2] ?? "");
    const c2 = validCol(cols[4] ?? "");
    if (c1 === undefined || c2 === undefined) return undefined;
    const a = colToken({ abs: cols[1] === "$", index: c1 }, resolve);
    const b = colToken({ abs: cols[3] === "$", index: c2 }, resolve);
    return { text: `${a}:${b}`, length: cols[0].length };
  }

  ROW_RANGE_RE.lastIndex = pos;
  const rows = ROW_RANGE_RE.exec(src);
  if (rows) {
    const r1 = validRow(rows[2] ?? "");
    const r2 = validRow(rows[4] ?? "");
    if (r1 === undefined || r2 === undefined) return undefined;
    const a = rowToken({ abs: rows[1] === "$", index: r1 }, resolve);
    const b = rowToken({ abs: rows[3] === "$", index: r2 }, resolve);
    return { text: `${a}:${b}`, length: rows[0].length };
  }
  return undefined;
}

/** Copies a "..." (with "" escapes) or '...' literal starting at `pos`. */
function literalEnd(src: string, pos: number): number {
  const quote = src[pos];
  let i = pos + 1;
  while (i < src.length) {
    if (src[i] === quote) {
      if (src[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return src.length;
}

export function encodeFormula(a1Formula: string, resolve: IdResolver): string {
  let out = "";
  let i = 0;
  while (i < a1Formula.length) {
    const ch = a1Formula[i] ?? "";
    if (ch === '"' || ch === "'") {
      const end = literalEnd(a1Formula, i);
      out += a1Formula.slice(i, end);
      i = end;
      continue;
    }
    const prev = i > 0 ? (a1Formula[i - 1] ?? "") : "";
    const startsRef = /[A-Za-z0-9$]/.test(ch) && !IDENT_CHAR.test(prev);
    // After "!" a reference belongs to another sheet (M5); copy it verbatim.
    const sheetQualified = prev === "!" && /[A-Za-z0-9$]/.test(ch);
    if (startsRef || sheetQualified) {
      const m = matchRef(a1Formula, i, resolve);
      const next = m ? (a1Formula[i + m.length] ?? "") : "";
      if (m && !/[A-Za-z0-9_(]/.test(next)) {
        out += sheetQualified ? a1Formula.slice(i, i + m.length) : m.text;
        i += m.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

const ID = "[A-Za-z0-9_-]+";
const TOKEN_RE = new RegExp(
  `\\[\\[(?:(\\$?)r:(${ID})(?:,(\\$?)c:(${ID}))?|(\\$?)c:(${ID}))\\]\\]`,
  "y",
);

function readToken(src: string, pos: number): { ref: ParsedIds; length: number } | undefined {
  TOKEN_RE.lastIndex = pos;
  const m = TOKEN_RE.exec(src);
  if (!m) return undefined;
  if (m[2] !== undefined) {
    return {
      length: m[0].length,
      ref: {
        row: { abs: m[1] === "$", id: m[2] },
        ...(m[4] !== undefined ? { col: { abs: m[3] === "$", id: m[4] } } : {}),
      },
    };
  }
  return { length: m[0].length, ref: { col: { abs: m[5] === "$", id: m[6] ?? "" } } };
}

interface ParsedIds {
  row?: { abs: boolean; id: string };
  col?: { abs: boolean; id: string };
}

function toA1(ref: ParsedIds, lookup: IdLookup, inRange: boolean): string | undefined {
  let rowPart: string | undefined;
  let colPart: string | undefined;
  if (ref.row) {
    const index = lookup.rowIndex(ref.row.id);
    if (index === undefined) return undefined;
    rowPart = `${ref.row.abs ? "$" : ""}${index + 1}`;
  }
  if (ref.col) {
    const index = lookup.colIndex(ref.col.id);
    if (index === undefined) return undefined;
    colPart = `${ref.col.abs ? "$" : ""}${colIndexToLabel(index)}`;
  }
  if (rowPart !== undefined && colPart !== undefined) return colPart + rowPart;
  const only = rowPart ?? colPart ?? "";
  // A lone whole-row/column token is only valid as a range endpoint.
  return inRange ? only : `${only}:${only}`;
}

export function decodeFormula(stored: string, lookup: IdLookup): string {
  let out = "";
  let i = 0;
  while (i < stored.length) {
    const ch = stored[i] ?? "";
    if (ch === '"' || ch === "'") {
      const end = literalEnd(stored, i);
      out += stored.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "[" && stored[i + 1] === "[") {
      const first = readToken(stored, i);
      if (first) {
        let end = i + first.length;
        let second: ReturnType<typeof readToken>;
        if (stored[end] === ":") {
          second = readToken(stored, end + 1);
          if (second) end += 1 + second.length;
        }
        if (second) {
          const a = toA1(first.ref, lookup, true);
          const b = toA1(second.ref, lookup, true);
          out += a === undefined || b === undefined ? REF_ERROR : `${a}:${b}`;
        } else {
          out += toA1(first.ref, lookup, false) ?? REF_ERROR;
        }
        i = end;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}
