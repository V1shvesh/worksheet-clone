import { describe, expect, it } from "vitest";
import { resolveActiveSheet } from "./resolve-active-sheet";

const order = ["a", "b", "c", "d"];

describe("resolveActiveSheet", () => {
  it("keeps a requested visible sheet without touching the URL", () => {
    expect(resolveActiveSheet({ requested: "c", order, visible: order, last: null })).toEqual({
      sheetId: "c",
      replaceUrl: false,
    });
  });

  it("falls back to the first visible sheet when the parameter is missing, unknown or hidden", () => {
    const visible = ["b", "c", "d"];
    for (const requested of [null, "zzz", "a"]) {
      expect(resolveActiveSheet({ requested, order, visible, last: null })).toEqual({
        sheetId: "b",
        replaceUrl: true,
      });
    }
  });

  it("returns null while the document has no sheets", () => {
    expect(resolveActiveSheet({ requested: "a", order: [], visible: [], last: null })).toBeNull();
  });

  it("picks the right neighbour when the current sheet is deleted", () => {
    // b (index 1) deleted: order is now a, c, d; c took its place.
    expect(
      resolveActiveSheet({
        requested: "b",
        order: ["a", "c", "d"],
        visible: ["a", "c", "d"],
        last: { id: "b", index: 1 },
      }),
    ).toEqual({ sheetId: "c", replaceUrl: true });
  });

  it("picks the left neighbour when the deleted sheet was last", () => {
    expect(
      resolveActiveSheet({
        requested: "d",
        order: ["a", "b", "c"],
        visible: ["a", "b", "c"],
        last: { id: "d", index: 3 },
      }),
    ).toEqual({ sheetId: "c", replaceUrl: true });
  });

  it("skips hidden neighbours when the current sheet gets hidden", () => {
    // c hidden; d hidden too: nearest visible to index 2 is b (distance 1).
    expect(
      resolveActiveSheet({
        requested: "c",
        order,
        visible: ["a", "b"],
        last: { id: "c", index: 2 },
      }),
    ).toEqual({ sheetId: "b", replaceUrl: true });
  });

  it("prefers the right neighbour on a tie", () => {
    expect(
      resolveActiveSheet({
        requested: "b",
        order,
        visible: ["a", "c", "d"],
        last: { id: "b", index: 1 },
      }),
    ).toEqual({ sheetId: "c", replaceUrl: true });
  });

  it("ignores the remembered position when the URL named another sheet", () => {
    expect(
      resolveActiveSheet({
        requested: "zzz",
        order,
        visible: order,
        last: { id: "c", index: 2 },
      }),
    ).toEqual({ sheetId: "a", replaceUrl: true });
  });
});
