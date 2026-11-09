import { describe, expect, it } from "vitest";
import { limitPasteEntries, MAX_CELL_CHARS, truncateCellInput } from "./cell-limits";

describe("truncateCellInput", () => {
  it("keeps text at or under the limit as is", () => {
    const atLimit = "a".repeat(MAX_CELL_CHARS);
    expect(truncateCellInput(atLimit)).toBe(atLimit);
  });

  it("cuts longer text to the limit", () => {
    expect(truncateCellInput("a".repeat(MAX_CELL_CHARS + 5))).toHaveLength(MAX_CELL_CHARS);
  });

  it("does not leave half of a surrogate pair at the cut", () => {
    const text = "a".repeat(MAX_CELL_CHARS - 1) + "😀";
    const cut = truncateCellInput(text);
    expect(cut).toBe("a".repeat(MAX_CELL_CHARS - 1));
  });
});

describe("limitPasteEntries", () => {
  it("returns the same entries and truncated=false when all fit", () => {
    const entries = [{ row: 0, col: 0, input: "x" }];
    const result = limitPasteEntries(entries);
    expect(result.truncated).toBe(false);
    expect(result.entries).toBe(entries);
  });

  it("cuts only the long inputs and keeps their position and format", () => {
    const result = limitPasteEntries([
      { row: 0, col: 0, input: "short" },
      { row: 1, col: 2, input: "b".repeat(MAX_CELL_CHARS + 1), format: { b: true } },
    ]);
    expect(result.truncated).toBe(true);
    expect(result.entries[0]?.input).toBe("short");
    expect(result.entries[1]).toMatchObject({ row: 1, col: 2, format: { b: true } });
    expect(result.entries[1]?.input).toHaveLength(MAX_CELL_CHARS);
  });
});
