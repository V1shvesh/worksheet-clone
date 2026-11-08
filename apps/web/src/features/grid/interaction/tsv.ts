// Clipboard text in the Excel / Google Sheets dialect: cells separated by a
// tab, rows by a newline. A cell containing a tab, newline or double quote is
// wrapped in double quotes with inner quotes doubled.

const NEEDS_QUOTES = /[\t\n\r"]/;

function quoteCell(cell: string): string {
  return NEEDS_QUOTES.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/** Rows of raw cell text to clipboard text (no trailing newline). */
export function serializeTsv(rows: string[][]): string {
  return rows
    .map((row, i) => {
      // A last row holding one empty cell would read back as a trailing
      // newline; an explicit "" keeps it.
      if (row.length === 1 && row[0] === "" && i === rows.length - 1) return '""';
      return row.map(quoteCell).join("\t");
    })
    .join("\n");
}

/**
 * Clipboard text to rows. Accepts \n and \r\n row breaks, ignores one trailing
 * row break, honours quoted cells (embedded tabs, newlines, "" escapes) and
 * pads ragged rows with "" to the widest row. A quote only opens a quoted cell
 * at the start of a cell; elsewhere it is literal. Empty text is one empty cell.
 */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let cellStart = true;
  let endedWithRowBreak = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    endedWithRowBreak = false;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cellStart) {
      inQuotes = true;
      cellStart = false;
    } else if (ch === "\t") {
      row.push(cell);
      cell = "";
      cellStart = true;
    } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
      if (ch === "\r") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      cellStart = true;
      endedWithRowBreak = true;
    } else {
      cell += ch;
      cellStart = false;
    }
  }
  if (!endedWithRowBreak) {
    row.push(cell);
    rows.push(row);
  }
  const width = Math.max(...rows.map((r) => r.length));
  return rows.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill("")] : r));
}
