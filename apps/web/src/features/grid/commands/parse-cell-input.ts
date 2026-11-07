export type ParsedCellInput =
  | { kind: "clear" }
  | { kind: "formula"; a1: string }
  | { kind: "value"; value: string | number | boolean };

const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** Turns what the user typed into a cell edit (Excel conventions). */
export function parseCellInput(raw: string): ParsedCellInput {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "clear" };
  // A leading apostrophe forces text; only the very first character counts.
  if (raw.startsWith("'")) {
    const text = raw.slice(1);
    return text === "" ? { kind: "clear" } : { kind: "value", value: text };
  }
  if (trimmed.startsWith("=") && trimmed.length > 1) return { kind: "formula", a1: trimmed };
  const upper = trimmed.toUpperCase();
  if (upper === "TRUE") return { kind: "value", value: true };
  if (upper === "FALSE") return { kind: "value", value: false };
  if (NUMBER_RE.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return { kind: "value", value: n };
  }
  return { kind: "value", value: raw };
}
