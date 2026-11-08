import { afterEach, describe, expect, it } from "vitest";
import { LOCAL_ORIGIN } from "../../../crdt/origin";
import { edit } from "../../../test-utils/workbook";
import { resolveSelection } from "./selection";
import { mountInteraction } from "./test-harness";

const mounted: ReturnType<typeof mountInteraction>[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.dispose();
});

const cell = (row: number, col: number) => ({ row, col });

function setup(opts: Parameters<typeof mountInteraction>[0] = {}) {
  const m = mountInteraction(opts);
  mounted.push(m);
  const grid = () => m.store.getState().grid;
  const selection = () => resolveSelection(grid().selection, m.model);
  const select = (row: number, col: number) => {
    m.view.pointerDown(cell(row, col));
    m.view.pointerUp(cell(row, col));
  };
  const key = (
    k: string,
    mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {},
  ) => m.view.keyDown({ key: k, ...mods });
  const text = (row: number, col: number) => m.model.getCell(cell(row, col)).text;
  const transactions: unknown[] = [];
  m.doc.on("afterTransaction", (tr) => {
    if (tr.changed.size > 0) transactions.push(tr.origin);
  });
  return { ...m, grid, selection, select, key, text, transactions };
}

describe("keyboard navigation (not editing)", () => {
  it("arrows move from the active cell (the anchor) and collapse the selection", () => {
    const { key, select, selection, view } = setup();
    select(3, 3);
    view.pointerDown(cell(5, 5), { shiftKey: true });
    view.pointerUp(cell(5, 5));
    key("ArrowDown");
    expect(selection()!.range).toEqual({ start: cell(4, 3), end: cell(4, 3) });
    key("ArrowLeft");
    key("ArrowUp");
    key("ArrowRight");
    expect(selection()!.focus).toEqual(cell(3, 3));
  });

  it("after Shift+arrows, typing edits the active cell (anchor), as in Excel/Sheets", () => {
    const { key, select, selection, grid, model } = setup();
    select(0, 0);
    key("ArrowDown", { shiftKey: true });
    key("ArrowRight", { shiftKey: true });
    expect(selection()!.range).toEqual({ start: cell(0, 0), end: cell(1, 1) });
    key("7");
    const editing = grid().editing!;
    expect(selection()!.range).toEqual({ start: cell(0, 0), end: cell(0, 0) });
    expect(editing.draft).toBe("7");
    expect([editing.rowId, editing.colId]).toEqual([model.rowIdAt(0), model.colIdAt(0)]);
  });

  it("shift+arrows extend from the anchor", () => {
    const { key, select, selection } = setup();
    select(2, 2);
    key("ArrowDown", { shiftKey: true });
    key("ArrowRight", { shiftKey: true });
    key("ArrowRight", { shiftKey: true });
    expect(selection()!.anchor).toEqual(cell(2, 2));
    expect(selection()!.range).toEqual({ start: cell(2, 2), end: cell(3, 4) });
    key("ArrowUp", { shiftKey: true });
    key("ArrowUp", { shiftKey: true });
    expect(selection()!.range).toEqual({ start: cell(1, 2), end: cell(2, 4) });
  });

  it("clamps at the grid edges", () => {
    const { key, select, selection, model } = setup();
    const { rowCount, colCount } = model.dimensions();
    select(0, 0);
    key("ArrowUp");
    key("ArrowLeft");
    expect(selection()!.focus).toEqual(cell(0, 0));
    select(rowCount - 1, colCount - 1);
    key("ArrowDown");
    key("ArrowRight");
    key("Tab");
    expect(selection()!.focus).toEqual(cell(rowCount - 1, colCount - 1));
  });

  it("Tab and Shift+Tab move right and left, Shift+Enter moves up", () => {
    const { key, select, selection } = setup();
    select(4, 4);
    key("Tab");
    expect(selection()!.focus).toEqual(cell(4, 5));
    key("Tab", { shiftKey: true });
    key("Tab", { shiftKey: true });
    expect(selection()!.focus).toEqual(cell(4, 3));
    key("Enter", { shiftKey: true });
    expect(selection()!.focus).toEqual(cell(3, 3));
  });

  it("arrows with no selection select A1", () => {
    const { key, selection } = setup();
    key("ArrowDown");
    expect(selection()!.focus).toEqual(cell(0, 0));
  });

  it("scrolls the new focus into view", () => {
    const { key, select, view } = setup();
    select(18, 0);
    expect(view.getCellRect(cell(30, 0))).toBeNull();
    for (let i = 0; i < 12; i++) key("ArrowDown");
    expect(view.getCellRect(cell(30, 0))).not.toBeNull();
  });

  it("Escape, unknown named keys and Ctrl/Cmd combos do nothing", () => {
    const { key, select, grid, transactions } = setup();
    select(1, 1);
    const before = grid();
    key("Escape");
    key("Shift");
    key("F5");
    key("c", { ctrlKey: true });
    key("ArrowDown", { ctrlKey: true });
    expect(grid()).toEqual(before);
    expect(transactions).toHaveLength(0);
  });
});

describe("undo/redo chords", () => {
  function withHistory() {
    const calls: string[] = [];
    const history = { undo: () => calls.push("undo"), redo: () => calls.push("redo") };
    return { calls, ...setup({ history }) };
  }

  it("Cmd/Ctrl+Z undoes; Cmd/Ctrl+Shift+Z and Ctrl+Y redo", () => {
    const { key, calls, select, transactions } = withHistory();
    select(1, 1);
    key("z", { metaKey: true });
    key("z", { ctrlKey: true });
    key("Z", { metaKey: true, shiftKey: true });
    key("Z", { ctrlKey: true, shiftKey: true });
    key("y", { ctrlKey: true });
    expect(calls).toEqual(["undo", "undo", "redo", "redo", "redo"]);
    expect(transactions).toHaveLength(0);
  });

  it("does not start an edit or treat other chords as history", () => {
    const { key, calls, select, grid } = withHistory();
    select(1, 1);
    key("y", { metaKey: true });
    expect(calls).toEqual([]);
    expect(grid().editing).toBeNull();
  });

  it("leaves Cmd+Z to the text editor while editing", () => {
    const { key, calls, select, grid } = withHistory();
    select(1, 1);
    key("a");
    key("z", { metaKey: true });
    expect(calls).toEqual([]);
    expect(grid().editing?.draft).toBe("a");
  });

  it("is a no-op without a history provider", () => {
    const { key, select, grid } = setup();
    select(1, 1);
    key("z", { metaKey: true });
    expect(grid().editing).toBeNull();
  });
});

describe("format chords", () => {
  it("Cmd/Ctrl+B/I/U toggle the selection's format in one transaction each, never while editing", () => {
    const { key, select, grid, transactions, model, view } = setup();
    select(1, 1);
    view.pointerDown(cell(2, 2), { shiftKey: true });
    view.pointerUp(cell(2, 2));
    key("b", { metaKey: true });
    key("I", { ctrlKey: true });
    expect(transactions).toHaveLength(2);
    expect(model.getCell(cell(2, 2)).format).toEqual({ b: true, i: true });
    key("b", { ctrlKey: true });
    expect(model.getCell(cell(1, 1)).format).toEqual({ i: true });
    expect(grid().editing).toBeNull();
    key("x");
    key("u", { metaKey: true });
    expect(transactions).toHaveLength(3);
  });

  it("does nothing for viewers", () => {
    const { key, select, transactions } = setup({ readOnly: true });
    select(1, 1);
    key("b", { metaKey: true });
    expect(transactions).toHaveLength(0);
  });
});

describe("editing", () => {
  it("characters typed with Alt (macOS) or AltGr (Ctrl+Alt on Windows) start editing", () => {
    const { key, select, grid } = setup();
    select(0, 0);
    key("€", { altKey: true });
    expect(grid().editing?.draft).toBe("€");

    const other = setup();
    other.select(0, 0);
    other.key("@", { ctrlKey: true, altKey: true });
    expect(other.grid().editing?.draft).toBe("@");
  });

  it("Ctrl/Cmd shortcuts and Alt with named keys never start editing", () => {
    const { key, select, grid, selection } = setup();
    select(2, 2);
    key("c", { ctrlKey: true });
    key("c", { metaKey: true });
    key("v", { metaKey: true, altKey: true });
    key("ArrowDown", { altKey: true });
    expect(grid().editing).toBeNull();
    expect(selection()!.range).toEqual({ start: cell(2, 2), end: cell(2, 2) });
  });

  it("typing a character starts editing with that character as the draft", () => {
    const { key, select, grid, doc, sheetId } = setup();
    edit(doc, sheetId, 1, 1, { v: "old" });
    select(1, 1);
    key("x");
    expect(grid().editing).toMatchObject({ draft: "x", mode: "typing" });
    expect(grid().editing!.rowId).toBe(grid().selection!.focus.rowId);
  });

  it("Enter and F2 start editing with the raw input; formulas show as A1 text", () => {
    const { key, select, grid, doc, sheetId, interaction } = setup();
    edit(doc, sheetId, 0, 0, { v: 2 });
    edit(doc, sheetId, 1, 0, { f: "=A1*3" });
    select(1, 0);
    key("Enter");
    expect(grid().editing).toMatchObject({ draft: "=A1*3", mode: "edit" });
    interaction.cancelEdit();
    key("F2");
    expect(grid().editing).toMatchObject({ draft: "=A1*3", mode: "edit" });
  });

  it("Enter on an empty cell starts editing with an empty draft", () => {
    const { key, select, grid } = setup();
    select(0, 0);
    key("Enter");
    expect(grid().editing).toMatchObject({ draft: "", mode: "edit" });
  });

  it("while editing, other keys are left to the editor", () => {
    const { key, select, grid, selection } = setup();
    select(0, 0);
    key("a");
    key("ArrowDown");
    key("b");
    key("Delete");
    expect(grid().editing!.draft).toBe("a");
    expect(selection()!.focus).toEqual(cell(0, 0));
  });

  it("Enter commits the parsed value and moves down; Shift+Enter moves up", () => {
    const { key, select, grid, selection, text, interaction, transactions } = setup();
    select(2, 0);
    key("4");
    interaction.updateDraft("42");
    key("Enter");
    expect(grid().editing).toBeNull();
    expect(text(2, 0)).toBe("42");
    expect(selection()!.range).toEqual({ start: cell(3, 0), end: cell(3, 0) });
    expect(transactions).toEqual([LOCAL_ORIGIN]);

    key("7");
    key("Enter", { shiftKey: true });
    expect(text(3, 0)).toBe("7");
    expect(selection()!.focus).toEqual(cell(2, 0));
  });

  it("Tab commits and moves right; Shift+Tab commits and moves left", () => {
    const { key, select, selection, text } = setup();
    select(0, 1);
    key("a");
    key("Tab");
    expect(text(0, 1)).toBe("a");
    expect(selection()!.focus).toEqual(cell(0, 2));
    key("b");
    key("Tab", { shiftKey: true });
    expect(text(0, 2)).toBe("b");
    expect(selection()!.focus).toEqual(cell(0, 1));
  });

  it("Enter at the last row commits and stays (clamped)", () => {
    const { key, select, selection, text, model } = setup();
    const last = model.dimensions().rowCount - 1;
    select(last, 0);
    key("9");
    key("Enter");
    expect(text(last, 0)).toBe("9");
    expect(selection()!.focus).toEqual(cell(last, 0));
  });

  it("Escape cancels without writing", () => {
    const { key, select, grid, text, transactions, selection } = setup();
    select(1, 1);
    key("z");
    key("Escape");
    expect(grid().editing).toBeNull();
    expect(text(1, 1)).toBe("");
    expect(transactions).toHaveLength(0);
    expect(selection()!.focus).toEqual(cell(1, 1));
  });

  it("committing an unchanged edit keeps text that looks like a number as text", () => {
    const { key, select, text, doc, sheetId, interaction, model } = setup();
    edit(doc, sheetId, 0, 0, { v: "007" });
    select(0, 0);
    key("F2");
    interaction.commitEdit(model.getRawInput(cell(0, 0)), null);
    expect(text(0, 0)).toBe("007");
  });

  it("typing =SUM(A1:A3) through the controller computes", () => {
    const { key, select, text, interaction } = setup();
    for (const [row, v] of [
      [0, "1"],
      [1, "2"],
      [2, "3"],
    ] as const) {
      select(row, 0);
      key(v);
      interaction.commitEdit(v, null);
    }
    select(3, 0);
    key("=");
    interaction.updateDraft("=SUM(A1:A3)");
    key("Enter");
    expect(text(3, 0)).toBe("6");
  });

  it("commitEdit from the overlay with no move keeps the selection", () => {
    const { key, select, selection, interaction, text } = setup();
    select(5, 5);
    key("q");
    interaction.commitEdit("hello", null);
    expect(text(5, 5)).toBe("hello");
    expect(selection()!.focus).toEqual(cell(5, 5));
  });

  it("commitEdit and cancelEdit are no-ops when not editing", () => {
    const { select, interaction, transactions, text } = setup();
    select(0, 0);
    interaction.commitEdit("ignored", "down");
    interaction.cancelEdit();
    interaction.updateDraft("ignored");
    expect(text(0, 0)).toBe("");
    expect(transactions).toHaveLength(0);
  });

  it("clicking another cell commits the open edit", () => {
    const { key, select, text, selection, interaction } = setup();
    select(0, 0);
    key("a");
    interaction.updateDraft("abc");
    select(4, 4);
    expect(text(0, 0)).toBe("abc");
    expect(selection()!.focus).toEqual(cell(4, 4));
  });

  it("double-clicking a cell starts editing with its raw input", () => {
    const { view, grid, doc, sheetId } = setup();
    edit(doc, sheetId, 2, 2, { v: "hi" });
    view.doubleClick(cell(2, 2));
    expect(grid().editing).toMatchObject({ draft: "hi", mode: "edit" });
  });

  it("the edit follows its cell when a collaborator inserts a row above", async () => {
    const { key, select, interaction, text, doc, sheetId } = setup();
    const { getRowOrderArray, newId } = await import("@worksheet-clone/shared");
    select(1, 1);
    key("v");
    doc.transact(() => getRowOrderArray(doc, sheetId).insert(0, [newId()]), Symbol("remote"));
    interaction.commitEdit("moved", null);
    expect(text(2, 1)).toBe("moved");
    expect(text(1, 1)).toBe("");
  });

  it("drops the edit if the edited row is deleted", async () => {
    const { key, select, grid, doc, sheetId, transactions } = setup();
    const { getRowOrderArray } = await import("@worksheet-clone/shared");
    select(1, 1);
    key("v");
    doc.transact(() => getRowOrderArray(doc, sheetId).delete(1, 1), Symbol("remote"));
    // Dropped as soon as the row is gone (with a toast), not only when Enter is pressed.
    expect(grid().editing).toBeNull();
    key("Enter");
    expect(transactions).not.toContain(LOCAL_ORIGIN);
  });
});

describe("Delete / clearRange", () => {
  it("clears a 2x3 range in exactly one LOCAL_ORIGIN transaction and keeps formats", () => {
    const { key, view, doc, sheetId, text, transactions, model } = setup();
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 4; c++) edit(doc, sheetId, r, c, { v: r * 10 + c });
    transactions.length = 0;

    view.pointerDown(cell(0, 1));
    view.pointerMove(cell(1, 3));
    view.pointerUp(cell(1, 3));
    key("Delete");

    expect(transactions).toEqual([LOCAL_ORIGIN]);
    for (let r = 0; r <= 1; r++) for (let c = 1; c <= 3; c++) expect(text(r, c)).toBe("");
    expect(text(0, 0)).toBe("0");
    expect(text(1, 0)).toBe("10");
    expect(text(2, 1)).toBe("21");
    expect(model.getRawInput(cell(0, 1))).toBe("");
  });

  it("Backspace also clears", () => {
    const { key, select, doc, sheetId, text } = setup();
    edit(doc, sheetId, 0, 0, { v: 5 });
    select(0, 0);
    key("Backspace");
    expect(text(0, 0)).toBe("");
  });

  it("clearing dependents updates formulas", () => {
    const { key, select, doc, sheetId, text } = setup();
    edit(doc, sheetId, 0, 0, { v: 5 });
    edit(doc, sheetId, 1, 0, { f: "=A1+1" });
    expect(text(1, 0)).toBe("6");
    select(0, 0);
    key("Delete");
    expect(text(1, 0)).toBe("1");
  });
});

describe("read-only", () => {
  it("navigates but never edits or clears", () => {
    const { key, select, selection, grid, doc, sheetId, text, transactions } = setup({
      readOnly: true,
    });
    edit(doc, sheetId, 0, 0, { v: 5 });
    transactions.length = 0;
    select(0, 0);
    key("ArrowDown");
    key("ArrowUp");
    expect(selection()!.focus).toEqual(cell(0, 0));
    key("Enter");
    key("F2");
    key("x");
    expect(grid().editing).toBeNull();
    key("Delete");
    expect(text(0, 0)).toBe("5");
    expect(transactions).toHaveLength(0);
  });

  it("double-click does not start editing", () => {
    const { view, grid } = setup({ readOnly: true });
    view.doubleClick(cell(1, 1));
    expect(grid().editing).toBeNull();
  });

  it("access changing to read-only mid-session is honoured", () => {
    const { key, select, target, text, transactions } = setup();
    select(0, 0);
    key("a");
    target.readOnly = true;
    key("Enter");
    expect(text(0, 0)).toBe("");
    expect(transactions).toHaveLength(0);
  });
});
