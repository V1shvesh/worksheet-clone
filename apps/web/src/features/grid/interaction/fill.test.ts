import { describe, expect, it } from "vitest";
import { fillExtent, planFill } from "./fill";
import type { FillCell } from "./fill-series";

const dims = { rowCount: 100, colCount: 26 };
const r = (a: [number, number], b: [number, number]) => ({
  start: { row: a[0], col: a[1] },
  end: { row: b[0], col: b[1] },
});
const at = (row: number, col: number) => ({ row, col });

describe("fillExtent", () => {
  const source = r([2, 2], [3, 3]);

  it.each([
    ["down", at(6, 3), "down", 3, r([4, 2], [6, 3])],
    ["up", at(0, 2), "up", 2, r([0, 2], [1, 3])],
    ["right", at(2, 6), "right", 3, r([2, 4], [3, 6])],
    ["left", at(3, 0), "left", 2, r([2, 0], [3, 1])],
  ])("%s", (_n, pointer, direction, count, target) => {
    const extent = fillExtent(source, pointer, dims)!;
    expect(extent.direction).toBe(direction);
    expect(extent.count).toBe(count);
    expect(extent.target).toEqual(target);
  });

  it("picks the axis the pointer is further from, rows winning ties", () => {
    expect(fillExtent(source, at(5, 6), dims)!.direction).toBe("right"); // 2 rows out, 3 cols out
    expect(fillExtent(source, at(7, 4), dims)!.direction).toBe("down"); // 4 rows out, 1 col out
    expect(fillExtent(source, at(5, 5), dims)!.direction).toBe("down"); // 2 and 2: tie
  });

  it("the union spans the source and the fill", () => {
    expect(fillExtent(source, at(6, 3), dims)!.union).toEqual(r([2, 2], [6, 3]));
    expect(fillExtent(source, at(0, 2), dims)!.union).toEqual(r([0, 2], [3, 3]));
  });

  it("is null inside the selection and clamps to the sheet", () => {
    expect(fillExtent(source, at(2, 2), dims)).toBeNull();
    expect(fillExtent(source, at(3, 3), dims)).toBeNull();
    expect(fillExtent(source, at(500, 3), dims)!.target).toEqual(r([4, 2], [99, 3]));
    expect(fillExtent(source, at(-1, 3), dims)!.target).toEqual(r([0, 2], [1, 3]));
    expect(fillExtent(r([99, 0], [99, 0]), at(120, 0), dims)).toBeNull();
  });
});

describe("planFill", () => {
  const num = (value: number): FillCell => ({ kind: "number", value });

  it("runs one series per column when filling down, targets in sheet order", () => {
    const source = r([0, 0], [1, 1]);
    const cells: Record<string, FillCell> = {
      "0,0": num(1),
      "1,0": num(2),
      "0,1": num(10),
      "1,1": num(20),
    };
    const extent = fillExtent(source, at(3, 1), dims)!;
    const writes = planFill(source, extent, (c) => cells[`${c.row},${c.col}`]!);
    expect(writes.map((w) => [w.row, w.col, (w.result as { value: number }).value])).toEqual([
      [2, 0, 3],
      [3, 0, 4],
      [2, 1, 30],
      [3, 1, 40],
    ]);
  });

  it("filling up places targets above, nearest first, formats cycling from the end", () => {
    const source = r([5, 0], [6, 0]);
    const extent = fillExtent(source, at(2, 0), dims)!;
    const writes = planFill(source, extent, (c) => num(c.row));
    expect(writes.map((w) => [w.row, (w.result as { value: number }).value])).toEqual([
      [4, 4],
      [3, 3],
      [2, 2],
    ]);
    expect(writes.map((w) => w.formatFrom.row)).toEqual([6, 5, 6]);
  });
});
