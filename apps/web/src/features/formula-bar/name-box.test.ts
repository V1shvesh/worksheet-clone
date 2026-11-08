import { describe, expect, it } from "vitest";
import { selectionLabel } from "./name-box";

const dims = { rowCount: 100, colCount: 26 };
const r = (r1: number, c1: number, r2: number, c2: number) => ({
  start: { row: r1, col: c1 },
  end: { row: r2, col: c2 },
});

describe("selectionLabel", () => {
  it.each([
    [r(0, 0, 0, 0), "A1"],
    [r(4, 27 - 26, 4, 1), "B5"],
    [r(1, 1, 4, 2), "B2:C5"],
    [r(0, 0, 99, 0), "A:A"],
    [r(0, 1, 99, 3), "B:D"],
    [r(2, 0, 2, 25), "3:3"],
    [r(2, 0, 5, 25), "3:6"],
    [r(0, 0, 99, 25), "A1:Z100"],
  ])("%j -> %s", (range, label) => {
    expect(selectionLabel(range, dims)).toBe(label);
  });
});
