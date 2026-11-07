import { describe, expect, it } from "vitest";
import { isHeaderHit, normalizeRange, rangeContains, targetsEqual } from "./types";

describe("port helpers", () => {
  it("normalizeRange orders corners on both axes", () => {
    expect(normalizeRange({ row: 5, col: 1 }, { row: 2, col: 4 })).toEqual({
      start: { row: 2, col: 1 },
      end: { row: 5, col: 4 },
    });
  });

  it("rangeContains is inclusive on all edges", () => {
    const r = normalizeRange({ row: 1, col: 1 }, { row: 3, col: 3 });
    expect(rangeContains(r, { row: 1, col: 1 })).toBe(true);
    expect(rangeContains(r, { row: 3, col: 3 })).toBe(true);
    expect(rangeContains(r, { row: 4, col: 3 })).toBe(false);
    expect(rangeContains(r, { row: 2, col: 0 })).toBe(false);
  });

  it("isHeaderHit distinguishes headers from cells and null", () => {
    expect(isHeaderHit({ kind: "corner" })).toBe(true);
    expect(isHeaderHit({ row: 0, col: 0 })).toBe(false);
    expect(isHeaderHit(null)).toBe(false);
  });

  it("targetsEqual compares kinds and indices", () => {
    expect(targetsEqual({ row: 1, col: 2 }, { row: 1, col: 2 })).toBe(true);
    expect(targetsEqual({ kind: "colHeader", col: 1 }, { kind: "colHeader", col: 1 })).toBe(true);
    expect(targetsEqual({ kind: "colHeader", col: 1 }, { kind: "colHeader", col: 2 })).toBe(false);
    expect(targetsEqual({ kind: "corner" }, { kind: "rowHeader", row: 0 })).toBe(false);
    expect(targetsEqual({ row: 0, col: 0 }, { kind: "corner" })).toBe(false);
    expect(targetsEqual(null, null)).toBe(true);
    expect(targetsEqual(null, { kind: "corner" })).toBe(false);
  });
});
