import { describe, expect, it } from "vitest";
import { fillSeries, type FillCell } from "./fill-series";

const num = (value: number): FillCell => ({ kind: "number", value });
const text = (value: string): FillCell => ({ kind: "text", value });
const f = (input: string): FillCell => ({ kind: "formula", input });
const values = (r: ReturnType<typeof fillSeries>) =>
  r.map((c) => (c.kind === "number" || c.kind === "text" || c.kind === "bool" ? c.value : c.kind));

describe("fillSeries linear numbers", () => {
  it("continues forward", () => {
    expect(values(fillSeries([num(1), num(2)], 3))).toEqual([3, 4, 5]);
    expect(values(fillSeries([num(10), num(20)], 1))).toEqual([30]);
    expect(values(fillSeries([num(5), num(3)], 2))).toEqual([1, -1]);
    expect(values(fillSeries([num(1), num(2), num(3)], 2))).toEqual([4, 5]);
  });
  it("extrapolates backward", () => {
    expect(values(fillSeries([num(3), num(4)], 3, "backward"))).toEqual([2, 1, 0]);
    expect(values(fillSeries([num(10), num(20)], 2, "backward"))).toEqual([0, -10]);
  });
  it("avoids float noise", () => {
    expect(values(fillSeries([num(0.1), num(0.2)], 3))).toEqual([0.3, 0.4, 0.5]);
    expect(values(fillSeries([num(0.1), num(0.2)], 2, "backward"))).toEqual([0, -0.1]);
    expect(values(fillSeries([num(1.5), num(3)], 2))).toEqual([4.5, 6]);
  });
  it("repeats a non-constant step cyclically", () => {
    expect(values(fillSeries([num(1), num(2), num(4)], 4))).toEqual([1, 2, 4, 1]);
  });
});

describe("fillSeries single cell", () => {
  it("copies a single number", () => {
    expect(values(fillSeries([num(7)], 3))).toEqual([7, 7, 7]);
    expect(values(fillSeries([num(7)], 2, "backward"))).toEqual([7, 7]);
  });
  it("increments a trailing integer in text", () => {
    expect(values(fillSeries([text("Item 1")], 3))).toEqual(["Item 2", "Item 3", "Item 4"]);
    expect(values(fillSeries([text("Q3")], 2))).toEqual(["Q4", "Q5"]);
    expect(values(fillSeries([text("A007")], 2))).toEqual(["A008", "A009"]);
    expect(values(fillSeries([text("A099")], 2))).toEqual(["A100", "A101"]);
    expect(values(fillSeries([text("A9")], 1))).toEqual(["A10"]);
  });
  it("decrements backward, keeping padding, and stops at zero", () => {
    expect(values(fillSeries([text("Item 3")], 2, "backward"))).toEqual(["Item 2", "Item 1"]);
    expect(values(fillSeries([text("A008")], 1, "backward"))).toEqual(["A007"]);
    expect(values(fillSeries([text("Item 1")], 3, "backward"))).toEqual([
      "Item 0",
      "Item 1",
      "Item 1",
    ]);
  });
  it("copies text without a trailing integer", () => {
    expect(values(fillSeries([text("hello")], 2))).toEqual(["hello", "hello"]);
    expect(values(fillSeries([text("1st")], 2))).toEqual(["1st", "1st"]);
  });
});

describe("fillSeries formulas", () => {
  it("reports the offset from the source cell", () => {
    expect(fillSeries([f("=A1*2")], 2)).toEqual([
      { kind: "formula", input: "=A1*2", offset: 1 },
      { kind: "formula", input: "=A1*2", offset: 2 },
    ]);
    expect(fillSeries([f("=A1*2")], 2, "backward")).toEqual([
      { kind: "formula", input: "=A1*2", offset: -1 },
      { kind: "formula", input: "=A1*2", offset: -2 },
    ]);
  });
  it("repeats a multi-cell pattern cyclically with the right offsets", () => {
    const r = fillSeries([f("=A1"), f("=B1")], 3);
    expect(r).toEqual([
      { kind: "formula", input: "=A1", offset: 2 },
      { kind: "formula", input: "=B1", offset: 2 },
      { kind: "formula", input: "=A1", offset: 4 },
    ]);
    expect(fillSeries([f("=A1"), f("=B1")], 3, "backward")).toEqual([
      { kind: "formula", input: "=B1", offset: -2 },
      { kind: "formula", input: "=A1", offset: -2 },
      { kind: "formula", input: "=B1", offset: -4 },
    ]);
  });
});

describe("fillSeries everything else repeats", () => {
  it("repeats mixed, boolean and empty blocks", () => {
    const b: FillCell = { kind: "bool", value: true };
    const e: FillCell = { kind: "empty" };
    expect(fillSeries([num(1), text("x")], 3)).toEqual([num(1), text("x"), num(1)]);
    expect(fillSeries([b], 2)).toEqual([b, b]);
    expect(fillSeries([e, num(5)], 3)).toEqual([e, num(5), e]);
    expect(fillSeries([num(1), text("x")], 3, "backward")).toEqual([text("x"), num(1), text("x")]);
  });
  it("returns nothing for count 0 or no source", () => {
    expect(fillSeries([num(1)], 0)).toEqual([]);
    expect(fillSeries([], 3)).toEqual([]);
  });
});
