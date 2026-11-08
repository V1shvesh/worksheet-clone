import { describe, expect, it } from "vitest";
import { MAX_TOASTS, toastsActions, toastsSlice } from "./toastsSlice";

const reduce = toastsSlice.reducer;
const empty = reduce(undefined, { type: "init" });

describe("toasts slice", () => {
  it("pushes toasts with increasing ids", () => {
    let state = reduce(empty, toastsActions.pushed("one", "a@x.com"));
    state = reduce(state, toastsActions.pushed("two"));
    expect(state.items.map((t) => [t.id, t.message, t.title])).toEqual([
      [1, "one", "a@x.com"],
      [2, "two", undefined],
    ]);
    expect(state.items[0]?.createdAt).toBeTypeOf("number");
  });

  it("keeps only the newest toasts", () => {
    let state = empty;
    for (let i = 0; i < MAX_TOASTS + 2; i++) {
      state = reduce(state, toastsActions.pushed(`m${i}`));
    }
    expect(state.items).toHaveLength(MAX_TOASTS);
    expect(state.items.map((t) => t.message)).toEqual(["m2", "m3", "m4"]);
  });

  it("dismisses by id and ignores unknown ids", () => {
    let state = reduce(empty, toastsActions.pushed("one"));
    state = reduce(state, toastsActions.pushed("two"));
    state = reduce(state, toastsActions.dismissed(999));
    expect(state.items).toHaveLength(2);
    state = reduce(state, toastsActions.dismissed(1));
    expect(state.items.map((t) => t.message)).toEqual(["two"]);
  });
});
