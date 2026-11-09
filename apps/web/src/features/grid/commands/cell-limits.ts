import type { PasteEntry } from "../interaction/clipboard";

// TODO(M9): use LIMITS.cellChars from shared once merged
/** The longest raw input one cell may hold (Excel's and Sheets' limit). */
export const MAX_CELL_CHARS = 32_767;

export const CELL_TOO_LONG_MESSAGE = `Some cells were longer than ${MAX_CELL_CHARS.toLocaleString("en-US")} characters and were cut`;

/** `text` cut to the cell limit. Splits by UTF-16 units, but never in the middle of a surrogate pair. */
export function truncateCellInput(text: string): string {
  if (text.length <= MAX_CELL_CHARS) return text;
  let end = MAX_CELL_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // a lone high surrogate would be left behind
  return text.slice(0, end);
}

/** The paste entries with every over-long input cut; `truncated` says whether any was. */
export function limitPasteEntries(entries: PasteEntry[]): {
  entries: PasteEntry[];
  truncated: boolean;
} {
  let truncated = false;
  const limited = entries.map((entry) => {
    if (entry.input.length <= MAX_CELL_CHARS) return entry;
    truncated = true;
    return { ...entry, input: truncateCellInput(entry.input) };
  });
  return { entries: truncated ? limited : entries, truncated };
}
