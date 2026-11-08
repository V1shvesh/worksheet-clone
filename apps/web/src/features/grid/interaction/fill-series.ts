// Fill-handle series for ONE line (a row or a column) of source cells.
//
// `source` is given in sheet order (top to bottom, or left to right). Targets
// are returned in the order they appear moving away from the source, so
// result[0] is adjacent to it; with direction "backward" (filling up or left)
// they continue backwards from the first source cell.
//
// A source cell's "position" is its index along the line (0..n-1); a target's
// position is n, n+1, ... going forward and -1, -2, ... going backward.

export type FillCell =
  | { kind: "number"; value: number }
  | { kind: "text"; value: string }
  | { kind: "bool"; value: boolean }
  /** `input` is the raw A1 formula, e.g. "=A1*2". */
  | { kind: "formula"; input: string }
  | { kind: "empty" };

export type FillValue = Exclude<FillCell, { kind: "formula" }>;

export type FillResult =
  | FillValue
  /**
   * The caller shifts `input` with shiftFormula by `offset` cells along the
   * fill line (positive = down / right; sign already reflects direction), i.e.
   * the target position minus the position of the source cell it copies.
   */
  | { kind: "formula"; input: string; offset: number };

export type FillDirection = "forward" | "backward";

const MAX_DECIMALS = 10;

function decimalPlaces(n: number): number {
  const s = String(n);
  const exp = /e-(\d+)$/.exec(s);
  if (exp) return Math.min(MAX_DECIMALS, Number(exp[1]));
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : Math.min(MAX_DECIMALS, s.length - dot - 1);
}

function roundTo(n: number, decimals: number): number {
  return Number(n.toFixed(decimals));
}

/** Linear step shared by every neighbouring pair, or undefined if there is none. */
function constantStep(values: number[]): number | undefined {
  const first = values[0] as number;
  const step = (values[1] as number) - first;
  const decimals = Math.max(...values.map(decimalPlaces));
  const tolerance = 10 ** -(decimals + 1);
  for (let i = 2; i < values.length; i++) {
    if (Math.abs((values[i] as number) - (values[i - 1] as number) - step) > tolerance) {
      return undefined;
    }
  }
  return step;
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

const TRAILING_INT = /^([\s\S]*?)(\d+)$/;

function incrementText(text: string, by: number): string | undefined {
  const m = TRAILING_INT.exec(text);
  if (!m) return undefined;
  const digits = m[2] as string;
  if (digits.length > 15) return undefined;
  const next = Number(digits) + by;
  if (next < 0) return undefined;
  return (m[1] as string) + String(next).padStart(digits.length, "0");
}

/** Cells for the next `count` positions after (or before) `source`. */
export function fillSeries(
  source: FillCell[],
  count: number,
  direction: FillDirection = "forward",
): FillResult[] {
  const n = source.length;
  if (n === 0 || count <= 0) return [];
  const position = (t: number) => (direction === "forward" ? n + t : -(t + 1));

  const numbers = source.every((c) => c.kind === "number")
    ? (source as { kind: "number"; value: number }[]).map((c) => c.value)
    : undefined;
  if (numbers && n >= 2) {
    const step = constantStep(numbers);
    if (step !== undefined) {
      const decimals = Math.max(decimalPlaces(step), ...numbers.map(decimalPlaces));
      return Array.from({ length: count }, (_, t) => ({
        kind: "number" as const,
        value: roundTo((numbers[0] as number) + step * position(t), decimals),
      }));
    }
  }

  const only = source[0] as FillCell;
  if (n === 1 && only.kind === "text") {
    return Array.from({ length: count }, (_, t) => {
      const text = incrementText(only.value, position(t));
      return { kind: "text" as const, value: text ?? only.value };
    });
  }

  return Array.from({ length: count }, (_, t) => {
    const p = position(t);
    const idx = mod(p, n);
    const cell = source[idx] as FillCell;
    return cell.kind === "formula" ? { kind: "formula", input: cell.input, offset: p - idx } : cell;
  });
}
