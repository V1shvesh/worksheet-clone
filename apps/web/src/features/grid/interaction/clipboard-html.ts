// The in-app clipboard payload, carried in the text/html flavor so a paste into
// the same app keeps raw inputs (A1 formulas) and formats. Other apps just see
// a <table> of the cell inputs.

export interface ClipFormat {
  bg?: string;
  b?: true;
  i?: true;
  u?: true;
}

export interface ClipCell {
  /** Raw input exactly as the cell editor shows it (value or A1 formula). */
  input: string;
  format?: ClipFormat;
}

export interface ClipboardPayload {
  v: 1;
  /** Top-left cell of the copied range, as visual indices in `sheetId`. */
  source: { sheetId: string; row: number; col: number };
  /** True for cut: the source is cleared after a successful paste. */
  cut: boolean;
  /** Row-major; null is an empty, unformatted cell. */
  cells: (ClipCell | null)[][];
}

const ATTR = "data-worksheet-clip";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The payload as an HTML table; the JSON rides in an escaped attribute of the table. */
export function serializeClipboardHtml(payload: Omit<ClipboardPayload, "v">): string {
  const json = JSON.stringify({ v: 1, ...payload });
  const body = payload.cells
    .map(
      (row) =>
        `<tr>${row
          .map((cell) => `<td>${escapeHtml(cell?.input ?? "").replaceAll("\n", "<br>")}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  return `<table ${ATTR}="${escapeHtml(json)}"><tbody>${body}</tbody></table>`;
}

function isInt(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0;
}

function parseFormat(raw: unknown): ClipFormat | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const f = raw as Record<string, unknown>;
  const out: ClipFormat = {};
  if (typeof f.bg === "string") out.bg = f.bg;
  if (f.b === true) out.b = true;
  if (f.i === true) out.i = true;
  if (f.u === true) out.u = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

function parsePayload(raw: unknown): ClipboardPayload | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  if (p.v !== 1 || typeof p.cut !== "boolean" || !Array.isArray(p.cells)) return undefined;
  const s = p.source as Record<string, unknown> | null;
  if (typeof s !== "object" || s === null) return undefined;
  if (typeof s.sheetId !== "string" || !isInt(s.row) || !isInt(s.col)) return undefined;
  const cells: (ClipCell | null)[][] = [];
  for (const row of p.cells as unknown[]) {
    if (!Array.isArray(row)) return undefined;
    const parsedRow: (ClipCell | null)[] = [];
    for (const cell of row as unknown[]) {
      if (cell === null) {
        parsedRow.push(null);
        continue;
      }
      if (typeof cell !== "object" || typeof (cell as ClipCell).input !== "string") {
        return undefined;
      }
      const format = parseFormat((cell as ClipCell).format);
      parsedRow.push({ input: (cell as ClipCell).input, ...(format ? { format } : {}) });
    }
    cells.push(parsedRow);
  }
  if (cells.length === 0) return undefined;
  return {
    v: 1,
    source: { sheetId: s.sheetId, row: s.row, col: s.col },
    cut: p.cut,
    cells,
  };
}

/**
 * Reads our payload back out of clipboard HTML, including the
 * `<html><body><!--StartFragment-->` wrapper browsers add. Anything else
 * (other apps' HTML, bad JSON, another version) gives undefined; never throws.
 */
export function parseClipboardHtml(html: string): ClipboardPayload | undefined {
  try {
    if (typeof DOMParser === "undefined" || !html.includes(ATTR)) return undefined;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const json = doc.querySelector(`[${ATTR}]`)?.getAttribute(ATTR);
    if (!json) return undefined;
    return parsePayload(JSON.parse(json));
  } catch {
    return undefined;
  }
}
