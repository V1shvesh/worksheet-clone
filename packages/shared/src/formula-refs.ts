// Formulas are stored with id-based references so they survive concurrent
// row/column inserts and deletes (PROJECT_CONTEXT §3.1), and are translated
// to A1 for display and for HyperFormula.
//
// Stored tokens: [[r:ROW,c:COL]] cell, [[c:COL]] whole column, [[r:ROW]] whole
// row; a "$" before r/c marks that axis absolute; ranges join two tokens
// with ":".
//
// Cross-sheet references carry the SHEET ID first: [[s:SID,r:ROW,c:COL]],
// [[s:SID,c:COL]], [[s:SID,r:ROW]]. In a range only the first token carries
// "s:"; the second endpoint inherits that sheet. A token without "s:" refers
// to the formula's own sheet (so documents written before cross-sheet support
// need no migration). A ref typed with an explicit prefix of the formula's own
// sheet is stored WITH "s:". Because ids, not names, are stored, renaming a
// sheet never breaks a formula; a deleted sheet decodes to #REF!.
//
// In A1 text a sheet prefix is `Name!` (unquoted identifier: letters, digits,
// "_" and "."; not starting with a digit) or a quoted name like 'My Sheet'!
// with a doubled quote as escape. Single quotes only ever delimit sheet names
// in formulas, so a quoted run directly followed by "!" is a prefix, never a
// string literal.

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

/** Everything the encoder needs to know about the workbook. */
export interface EncodeContext {
  /** The sheet the formula lives in; unprefixed refs resolve against it. */
  sheetId: string;
  /**
   * Maps a typed sheet name to its id, or undefined when no such sheet exists.
   * Must match case-insensitively (see {@link createSheetNameIndex}).
   */
  sheetIdByName(name: string): string | undefined;
  /** Row/column id resolver for a sheet (may create ids; the codec stays pure). */
  resolver(sheetId: string): IdResolver;
}

export interface DecodeContext {
  /** The sheet the formula lives in; unprefixed tokens resolve against it. */
  sheetId: string;
  /** Row/column index lookup for a sheet; undefined when the sheet is deleted. */
  lookup(sheetId: string): IdLookup | undefined;
  /**
   * How to print a sheet prefix including the trailing "!": `Sheet2!` or
   * `'my sheet'!` for display (see {@link formatSheetPrefix}), `'SID'!` for
   * HyperFormula, which names its sheets by id (always quoted).
   */
  sheetPrefix(sheetId: string): string;
}

const MAX_COL_INDEX = 16383; // XFD
const MAX_ROW = 1048576;
const REF_ERROR = "#REF!";

const PLAIN_SHEET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;
const UNQUOTED_PREFIX_RE = /([A-Za-z_][A-Za-z0-9_.]*)!/y;

/** True when an unquoted `name!` could be misread as a cell, column, R1C1 ref or boolean. */
function looksLikeReference(name: string): boolean {
  return (
    /^[A-Za-z]{1,3}\d*$/.test(name) || // A1, AB (a column), A
    /^[Rr]\d*[Cc]\d*$/.test(name) || // R1C1, R, C, RC
    /^(true|false)$/i.test(name)
  );
}

/**
 * Quotes a sheet name for A1 text. Names are quoted unless they are plain
 * identifiers that cannot be mistaken for a reference; `alwaysQuote` is for the
 * formula engine, whose sheet names are ids that may start with a digit.
 */
export function quoteSheetName(name: string, alwaysQuote = false): string {
  if (!alwaysQuote && PLAIN_SHEET_NAME_RE.test(name) && !looksLikeReference(name)) return name;
  return `'${name.replaceAll("'", "''")}'`;
}

/** `quoteSheetName(name)` plus the trailing "!". */
export function formatSheetPrefix(name: string, options: { alwaysQuote?: boolean } = {}): string {
  return `${quoteSheetName(name, options.alwaysQuote ?? false)}!`;
}

/** Case-insensitive name to id lookup for {@link EncodeContext.sheetIdByName}; first sheet wins on duplicates. */
export function createSheetNameIndex(
  sheets: Iterable<{ id: string; name: string }>,
): (name: string) => string | undefined {
  const byName = new Map<string, string>();
  for (const { id, name } of sheets) {
    const key = name.toLowerCase();
    if (!byName.has(key)) byName.set(key, id);
  }
  return (name) => byName.get(name.toLowerCase());
}

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

/** How a matched reference is written back; encode and shift each supply one. */
interface RefEmitter {
  cell(r: Axis, c: Axis): string;
  col(c: Axis): string;
  row(r: Axis): string;
  join(a: string, b: string): string;
}

function idEmitter(resolve: IdResolver): RefEmitter {
  return {
    cell: (r, c) =>
      `[[${r.abs ? "$" : ""}r:${resolve.rowId(r.index)},${c.abs ? "$" : ""}c:${resolve.colId(c.index)}]]`,
    col: (c) => `[[${c.abs ? "$" : ""}c:${resolve.colId(c.index)}]]`,
    row: (r) => `[[${r.abs ? "$" : ""}r:${resolve.rowId(r.index)}]]`,
    join: (a, b) => `${a}:${b}`,
  };
}

/** Tries to read a reference at `pos`; returns its rewritten text and source length. */
function matchRef(
  src: string,
  pos: number,
  emit: RefEmitter,
): { text: string; length: number } | undefined {
  CELL_RANGE_RE.lastIndex = pos;
  const cell = CELL_RANGE_RE.exec(src);
  if (cell) {
    const col1 = validCol(cell[2] ?? "");
    const row1 = validRow(cell[4] ?? "");
    if (col1 !== undefined && row1 !== undefined) {
      const a = emit.cell(
        { abs: cell[3] === "$", index: row1 },
        { abs: cell[1] === "$", index: col1 },
      );
      if (cell[6] === undefined) return { text: a, length: cell[0].length };
      const col2 = validCol(cell[6]);
      const row2 = validRow(cell[8] ?? "");
      if (col2 !== undefined && row2 !== undefined) {
        const b = emit.cell(
          { abs: cell[7] === "$", index: row2 },
          { abs: cell[5] === "$", index: col2 },
        );
        return { text: emit.join(a, b), length: cell[0].length };
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
    const a = emit.col({ abs: cols[1] === "$", index: c1 });
    const b = emit.col({ abs: cols[3] === "$", index: c2 });
    return { text: emit.join(a, b), length: cols[0].length };
  }

  ROW_RANGE_RE.lastIndex = pos;
  const rows = ROW_RANGE_RE.exec(src);
  if (rows) {
    const r1 = validRow(rows[2] ?? "");
    const r2 = validRow(rows[4] ?? "");
    if (r1 === undefined || r2 === undefined) return undefined;
    const a = emit.row({ abs: rows[1] === "$", index: r1 });
    const b = emit.row({ abs: rows[3] === "$", index: r2 });
    return { text: emit.join(a, b), length: rows[0].length };
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

/** Reads a sheet prefix (`Name!` or a quoted name followed by "!") at `pos`. */
function readSheetPrefix(src: string, pos: number): { name: string; length: number } | undefined {
  if (src[pos] === "'") {
    const end = literalEnd(src, pos);
    if (src[end - 1] !== "'" || end - pos < 2 || src[end] !== "!") return undefined;
    return { name: src.slice(pos + 1, end - 1).replaceAll("''", "'"), length: end + 1 - pos };
  }
  UNQUOTED_PREFIX_RE.lastIndex = pos;
  const m = UNQUOTED_PREFIX_RE.exec(src);
  return m ? { name: m[1] ?? "", length: m[0].length } : undefined;
}

/** Marks the first token of an encoded ref/range as belonging to `sheetId`. */
function qualify(text: string, sheetId: string): string {
  return `[[s:${sheetId},${text.slice(2)}`;
}

/** What to do with the references that follow a given sheet prefix (or none). */
interface RefTarget {
  emit: RefEmitter;
  /** Final text for a matched reference; `prefix` is the verbatim source prefix ("" when none). */
  wrap(prefix: string, text: string, source: string): string;
}

/**
 * Walks A1 text and rewrites every reference. Strings, function names and
 * anything that does not read as a reference are copied verbatim.
 */
function rewriteRefs(a1Formula: string, targetFor: (sheetName: string | undefined) => RefTarget) {
  let out = "";
  let i = 0;
  while (i < a1Formula.length) {
    const ch = a1Formula[i] ?? "";
    const prev = i > 0 ? (a1Formula[i - 1] ?? "") : "";
    if (ch === "'" || (/[A-Za-z_]/.test(ch) && !IDENT_CHAR.test(prev))) {
      const prefix = readSheetPrefix(a1Formula, i);
      if (prefix) {
        const refStart = i + prefix.length;
        const target = targetFor(prefix.name);
        const m = matchRef(a1Formula, refStart, target.emit);
        const next = m ? (a1Formula[refStart + m.length] ?? "") : "";
        if (m && !/[A-Za-z0-9_(]/.test(next)) {
          out += target.wrap(
            a1Formula.slice(i, refStart),
            m.text,
            a1Formula.slice(refStart, refStart + m.length),
          );
          i = refStart + m.length;
        } else {
          // Not a reference after all: leave the prefix text alone.
          out += a1Formula.slice(i, refStart);
          i = refStart;
        }
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      const end = literalEnd(a1Formula, i);
      out += a1Formula.slice(i, end);
      i = end;
      continue;
    }
    if (/[A-Za-z0-9$]/.test(ch) && !IDENT_CHAR.test(prev)) {
      const target = targetFor(undefined);
      const m = matchRef(a1Formula, i, target.emit);
      const next = m ? (a1Formula[i + m.length] ?? "") : "";
      if (m && !/[A-Za-z0-9_(]/.test(next)) {
        out += target.wrap("", m.text, a1Formula.slice(i, i + m.length));
        i += m.length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * A1 formula text to stored (id-based) form. References to unknown sheets and
 * text the codec cannot read as a reference are kept verbatim.
 */
export function encodeFormula(a1Formula: string, ctx: EncodeContext): string {
  return rewriteRefs(a1Formula, (name) => {
    const sheetId = name === undefined ? undefined : ctx.sheetIdByName(name);
    return {
      emit: idEmitter(ctx.resolver(sheetId ?? ctx.sheetId)),
      wrap: (prefix, text, source) =>
        name === undefined
          ? text
          : sheetId === undefined
            ? prefix + source
            : qualify(text, sheetId),
    };
  });
}

export interface ShiftBounds {
  rowCount: number;
  colCount: number;
}

/**
 * Moves an A1 formula as if copied by (`rows`, `cols`): every relative part of
 * every reference shifts, `$`-anchored parts stay. A part shifted outside
 * 0..count-1 turns the whole reference (or range, as in Excel) into `#REF!`.
 * Bounds describe the destination sheet and are also applied to sheet-qualified
 * refs (limitation: all sheets share one size until row/column inserts exist).
 */
export function shiftFormula(
  a1Formula: string,
  rows: number,
  cols: number,
  bounds: ShiftBounds,
): string {
  const moveRow = (r: Axis): number | undefined => {
    const index = r.abs ? r.index : r.index + rows;
    return index >= 0 && index < bounds.rowCount ? index : undefined;
  };
  const moveCol = (c: Axis): number | undefined => {
    const index = c.abs ? c.index : c.index + cols;
    return index >= 0 && index < bounds.colCount ? index : undefined;
  };
  const rowText = (r: Axis) => {
    const index = moveRow(r);
    return index === undefined ? undefined : `${r.abs ? "$" : ""}${index + 1}`;
  };
  const colText = (c: Axis) => {
    const index = moveCol(c);
    return index === undefined ? undefined : `${c.abs ? "$" : ""}${colIndexToLabel(index)}`;
  };
  const emit: RefEmitter = {
    cell: (r, c) => {
      const rt = rowText(r);
      const ct = colText(c);
      return rt === undefined || ct === undefined ? REF_ERROR : ct + rt;
    },
    col: (c) => colText(c) ?? REF_ERROR,
    row: (r) => rowText(r) ?? REF_ERROR,
    join: (a, b) => (a === REF_ERROR || b === REF_ERROR ? REF_ERROR : `${a}:${b}`),
  };
  const target: RefTarget = {
    emit,
    wrap: (prefix, text) => (text === REF_ERROR ? text : prefix + text),
  };
  return rewriteRefs(a1Formula, () => target);
}

const ID = "[A-Za-z0-9_-]+";
const TOKEN_RE = new RegExp(
  `\\[\\[(?:s:(${ID}),)?(?:(\\$?)r:(${ID})(?:,(\\$?)c:(${ID}))?|(\\$?)c:(${ID}))\\]\\]`,
  "y",
);

interface ParsedIds {
  sheet?: string;
  row?: { abs: boolean; id: string };
  col?: { abs: boolean; id: string };
}

function readToken(src: string, pos: number): { ref: ParsedIds; length: number } | undefined {
  TOKEN_RE.lastIndex = pos;
  const m = TOKEN_RE.exec(src);
  if (!m) return undefined;
  const sheet = m[1] !== undefined ? { sheet: m[1] } : {};
  if (m[3] !== undefined) {
    return {
      length: m[0].length,
      ref: {
        ...sheet,
        row: { abs: m[2] === "$", id: m[3] },
        ...(m[5] !== undefined ? { col: { abs: m[4] === "$", id: m[5] } } : {}),
      },
    };
  }
  return { length: m[0].length, ref: { ...sheet, col: { abs: m[6] === "$", id: m[7] ?? "" } } };
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

/**
 * Stored (id-based) formula to A1 text. Refs to a deleted sheet, row or column
 * (and ranges with any such endpoint) become `#REF!`.
 */
export function decodeFormula(stored: string, ctx: DecodeContext): string {
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
        const sheetId = first.ref.sheet ?? ctx.sheetId;
        const lookup = ctx.lookup(sheetId);
        const prefix = first.ref.sheet !== undefined ? ctx.sheetPrefix(sheetId) : "";
        const otherSheet = second?.ref.sheet !== undefined && second.ref.sheet !== sheetId;
        if (lookup === undefined || otherSheet) {
          out += REF_ERROR;
        } else if (second) {
          const a = toA1(first.ref, lookup, true);
          const b = toA1(second.ref, lookup, true);
          out += a === undefined || b === undefined ? REF_ERROR : `${prefix}${a}:${b}`;
        } else {
          const a = toA1(first.ref, lookup, false);
          out += a === undefined ? REF_ERROR : prefix + a;
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

/** Ids of the sheets a stored formula mentions via `s:` tokens (string literals skipped). */
export function referencedSheetIds(stored: string): Set<string> {
  const ids = new Set<string>();
  let i = 0;
  while (i < stored.length) {
    const ch = stored[i];
    if (ch === '"' || ch === "'") {
      i = literalEnd(stored, i);
      continue;
    }
    if (ch === "[" && stored[i + 1] === "[") {
      const token = readToken(stored, i);
      if (token) {
        if (token.ref.sheet !== undefined) ids.add(token.ref.sheet);
        i += token.length;
        continue;
      }
    }
    i++;
  }
  return ids;
}

/**
 * Makes every reference of a stored formula explicit about its sheet: tokens without `s:`
 * (which mean "my own sheet") get `s:<sheetId>`. Used when a formula moves to another sheet
 * unchanged (cut and paste), so it keeps pointing at the cells it pointed at. The second
 * endpoint of a range inherits the first one's sheet and is left alone.
 */
export function qualifyStoredFormula(stored: string, sheetId: string): string {
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
        const text = stored.slice(i, i + first.length);
        out += first.ref.sheet === undefined ? `[[s:${sheetId},${text.slice(2)}` : text;
        let end = i + first.length;
        if (stored[end] === ":") {
          const second = readToken(stored, end + 1);
          if (second) {
            out += stored.slice(end, end + 1 + second.length);
            end += 1 + second.length;
          }
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

export interface RetargetContext {
  /** The sheet the formula lives in; unqualified tokens refer to it. */
  sheetId: string;
  /** Row ids being deleted, per sheet. */
  deletedRows: ReadonlyMap<string, ReadonlySet<string>>;
  /** Column ids being deleted, per sheet. */
  deletedCols: ReadonlyMap<string, ReadonlySet<string>>;
  /** Row and column order of a sheet BEFORE the deletion; undefined for an unknown sheet. */
  orderOf(sheetId: string): { rows: string[]; cols: string[] } | undefined;
}

type AxisRef = { abs: boolean; id: string };

/** Outcome for one axis of a range: unchanged, new endpoint ids, or "dead" (nothing of the range survives). */
function shrinkAxis(
  a: AxisRef,
  b: AxisRef,
  order: readonly string[],
  deleted: ReadonlySet<string> | undefined,
): { a: AxisRef; b: AxisRef } | "dead" {
  if (!deleted || (!deleted.has(a.id) && !deleted.has(b.id))) return { a, b };
  const ia = order.indexOf(a.id);
  const ib = order.indexOf(b.id);
  if (ia === -1 || ib === -1) return { a, b };
  const survivors = order
    .slice(Math.min(ia, ib), Math.max(ia, ib) + 1)
    .filter((id) => !deleted.has(id));
  const first = survivors[0];
  const last = survivors.at(-1);
  if (first === undefined || last === undefined) return "dead";
  const forward = ia <= ib;
  return {
    a: deleted.has(a.id) ? { abs: a.abs, id: forward ? first : last } : a,
    b: deleted.has(b.id) ? { abs: b.abs, id: forward ? last : first } : b,
  };
}

function writeToken(ref: ParsedIds, withSheet: boolean): string {
  const parts: string[] = [];
  if (withSheet && ref.sheet !== undefined) parts.push(`s:${ref.sheet}`);
  if (ref.row) parts.push(`${ref.row.abs ? "$" : ""}r:${ref.row.id}`);
  if (ref.col) parts.push(`${ref.col.abs ? "$" : ""}c:${ref.col.id}`);
  return `[[${parts.join(",")}]]`;
}

/**
 * Excel-style range shrink for a stored formula about to lose rows/columns:
 * a range whose first or last row (column) is deleted has that endpoint moved
 * to the nearest surviving row (column) inside the range, in the pre-deletion
 * order; the `$` flag stays. A range with no survivor on an axis is left alone
 * and decodes to #REF! afterwards. Single-cell refs are untouched (they turn
 * into #REF! on their own), as are string literals.
 */
export function retargetDeleted(stored: string, ctx: RetargetContext): string {
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
        const firstEnd = i + first.length;
        const second = stored[firstEnd] === ":" ? readToken(stored, firstEnd + 1) : undefined;
        const end = second ? firstEnd + 1 + second.length : firstEnd;
        const original = stored.slice(i, end);
        out += second ? (retargetRange(first.ref, second.ref, ctx) ?? original) : original;
        i = end;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** The rewritten range text, or undefined to keep the original. */
function retargetRange(a: ParsedIds, b: ParsedIds, ctx: RetargetContext): string | undefined {
  const sheetId = a.sheet ?? ctx.sheetId;
  if (b.sheet !== undefined && b.sheet !== sheetId) return undefined;
  if (Boolean(a.row) !== Boolean(b.row) || Boolean(a.col) !== Boolean(b.col)) return undefined;
  const order = ctx.orderOf(sheetId);
  if (!order) return undefined;
  const rows =
    a.row && b.row ? shrinkAxis(a.row, b.row, order.rows, ctx.deletedRows.get(sheetId)) : undefined;
  const cols =
    a.col && b.col ? shrinkAxis(a.col, b.col, order.cols, ctx.deletedCols.get(sheetId)) : undefined;
  if (rows === "dead" || cols === "dead") return undefined;
  const na: ParsedIds = {
    ...a,
    ...(rows ? { row: rows.a } : {}),
    ...(cols ? { col: cols.a } : {}),
  };
  const nb: ParsedIds = {
    ...b,
    ...(rows ? { row: rows.b } : {}),
    ...(cols ? { col: cols.b } : {}),
  };
  return `${writeToken(na, true)}:${writeToken(nb, true)}`;
}
