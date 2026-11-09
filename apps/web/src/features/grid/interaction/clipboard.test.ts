import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  addSheet,
  cellKey,
  getCell,
  getFormatsMap,
  readColOrder,
  readRowOrder,
} from "@worksheet-clone/shared";
import { createWorkbookUndo } from "../../../crdt/undo";
import { LOCAL_ORIGIN } from "../../../crdt/origin";
import { edit } from "../../../test-utils/workbook";
import { CELL_TOO_LONG_MESSAGE, MAX_CELL_CHARS } from "../commands/cell-limits";
import { MAX_PASTE_CELLS, type ClipboardDataLike } from "./clipboard";
import { parseClipboardHtml } from "./clipboard-html";
import { resolveSelection } from "./selection";
import { mountInteraction } from "./test-harness";

const mounted: ReturnType<typeof mountInteraction>[] = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.dispose();
});

function fakeData(initial: Record<string, string> = {}): ClipboardDataLike & {
  store: Record<string, string>;
} {
  const store = { ...initial };
  return {
    store,
    getData: (type) => store[type] ?? "",
    setData: (type, value) => {
      store[type] = value;
    },
  };
}

function setup(opts: Parameters<typeof mountInteraction>[0] = {}) {
  const m = mountInteraction(opts);
  mounted.push(m);
  const txs: unknown[] = [];
  m.doc.on("afterTransaction", (tr: Y.Transaction) => {
    if (tr.changed.size > 0) txs.push(tr.origin);
  });
  const c = (row: number, col: number) => ({ row, col });
  const select = (a: [number, number], f: [number, number] = a) => {
    m.view.pointerDown(c(...a));
    if (f[0] !== a[0] || f[1] !== a[1]) m.view.pointerMove(c(...f));
    m.view.pointerUp(c(...f));
  };
  const put = (row: number, col: number, input: Parameters<typeof edit>[4]) => {
    edit(m.doc, m.sheetId, row, col, input);
    txs.length = 0;
  };
  const raw = (row: number, col: number) => m.model.getRawInput(c(row, col));
  const shown = (row: number, col: number) => m.model.getCell(c(row, col)).text;
  const range = () => resolveSelection(m.store.getState().grid.selection, m.model)?.range;
  const toasts = () => m.store.getState().toasts.items.map((t) => t.message);
  const copy = (cut = false) => {
    const data = fakeData();
    expect(m.interaction.copy(data, cut)).toBe(true);
    return data;
  };
  return { ...m, txs, c, select, put, raw, shown, range, toasts, copy };
}

describe("copy", () => {
  it("writes displayed values as TSV and a payload with raw inputs and formats", () => {
    const t = setup();
    t.put(0, 0, { v: 2 });
    t.put(0, 1, { f: "=A1*3" });
    t.put(1, 0, { v: "a\tb" });
    t.put(1, 1, { f: "=A1/0" });
    t.doc.transact(() =>
      getFormatsMap(t.doc, t.sheetId).set(
        cellKey(readRowOrder(t.doc, t.sheetId)[0]!, readColOrder(t.doc, t.sheetId)[0]!),
        { b: true, bg: "#fff2a8" },
      ),
    );
    t.txs.length = 0;
    t.select([0, 0], [1, 1]);
    const data = t.copy();
    expect(data.store["text/plain"]).toBe('2\t6\n"a\tb"\t#DIV/0!');
    const html = data.store["text/html"]!;
    const payload = parseClipboardHtml(html)!;
    expect(payload.source).toEqual({ sheetId: t.sheetId, row: 0, col: 0 });
    expect(payload.cut).toBe(false);
    expect(payload.cells[0]![0]).toEqual({ input: "2", format: { b: true, bg: "#fff2a8" } });
    expect(payload.cells[0]![1]).toEqual({ input: "=A1*3" });
    // other apps see displayed values in the visible table, never the formula text
    const visible = html.slice(html.indexOf("<tbody>"));
    expect(visible).toContain("<td>6</td>");
    expect(visible).toContain("<td>#DIV/0!</td>");
    expect(visible).not.toContain("=A1*3");
    expect(t.txs).toHaveLength(0);
  });

  it("is not handled without a selection or while editing", () => {
    const t = setup();
    expect(t.interaction.copy(fakeData(), false)).toBe(false);
    t.select([0, 0]);
    t.view.keyDown({ key: "F2" });
    expect(t.interaction.copy(fakeData(), false)).toBe(false);
    expect(t.interaction.paste(fakeData({ "text/plain": "x" }))).toBe(false);
  });

  it("works for viewers, but a viewer cannot cut", () => {
    const t = setup({ readOnly: true });
    t.put(0, 0, { v: 5 });
    t.select([0, 0]);
    expect(t.copy().store["text/plain"]).toBe("5");
    const data = fakeData();
    expect(t.interaction.copy(data, true)).toBe(true);
    expect(data.store).toEqual({});
    expect(t.store.getState().clipboard.cutMark).toBeNull();
  });
});

describe("paste", () => {
  it("pastes our payload with relative formulas shifted, formats included, in one transaction", () => {
    const t = setup();
    t.put(0, 0, { v: 1 });
    t.put(0, 1, { f: "=A1*2+$A$1" });
    t.doc.transact(
      () =>
        getFormatsMap(t.doc, t.sheetId).set(
          cellKey(readRowOrder(t.doc, t.sheetId)[0]!, readColOrder(t.doc, t.sheetId)[1]!),
          { i: true },
        ),
      LOCAL_ORIGIN,
    );
    t.txs.length = 0;
    t.select([0, 0], [0, 1]);
    const data = t.copy();
    t.select([4, 3]);
    expect(t.interaction.paste(data)).toBe(true);
    expect(t.raw(4, 3)).toBe("1");
    expect(t.raw(4, 4)).toBe("=D5*2+$A$1");
    expect(t.shown(4, 4)).toBe("3");
    expect(
      getFormatsMap(t.doc, t.sheetId).get(
        cellKey(readRowOrder(t.doc, t.sheetId)[4]!, readColOrder(t.doc, t.sheetId)[4]!),
      ),
    ).toEqual({ i: true });
    expect(t.txs).toEqual([LOCAL_ORIGIN]);
    expect(t.range()).toEqual({ start: t.c(4, 3), end: t.c(4, 4) });
  });

  it("an empty source cell clears the destination content and format", () => {
    const t = setup();
    t.put(0, 1, { v: 9 });
    t.select([0, 0], [0, 1]);
    const data = t.copy();
    t.put(5, 0, { v: "old" });
    t.put(5, 1, { v: "old2" });
    t.select([5, 0]);
    t.interaction.paste(data);
    expect(t.raw(5, 0)).toBe("");
    expect(t.raw(5, 1)).toBe("9");
  });

  it("pastes external text through the typing path and leaves formats alone", () => {
    const t = setup();
    t.put(3, 1, { v: 1 });
    t.doc.transact(() =>
      getFormatsMap(t.doc, t.sheetId).set(
        cellKey(readRowOrder(t.doc, t.sheetId)[3]!, readColOrder(t.doc, t.sheetId)[1]!),
        { b: true },
      ),
    );
    t.txs.length = 0;
    t.select([3, 0]);
    const text = 'a\t"x\ty"\n007\t=A1\n\t12.5\r\n';
    expect(t.interaction.paste(fakeData({ "text/plain": text }))).toBe(true);
    expect(t.raw(3, 0)).toBe("a");
    expect(t.raw(3, 1)).toBe("x\ty");
    expect(t.shown(4, 0)).toBe("7");
    expect(t.raw(4, 1)).toBe("=A1");
    expect(
      getCell(
        t.doc,
        t.sheetId,
        readRowOrder(t.doc, t.sheetId)[4]!,
        readColOrder(t.doc, t.sheetId)[1]!,
      )?.f,
    ).toBeDefined();
    expect(t.raw(5, 0)).toBe("");
    expect(t.raw(5, 1)).toBe("12.5");
    expect(
      getFormatsMap(t.doc, t.sheetId).get(
        cellKey(readRowOrder(t.doc, t.sheetId)[3]!, readColOrder(t.doc, t.sheetId)[1]!),
      ),
    ).toEqual({ b: true });
    expect(t.txs).toEqual([LOCAL_ORIGIN]);
    expect(t.range()).toEqual({ start: t.c(3, 0), end: t.c(5, 1) });
  });

  it("cuts over-long pasted cells to the cell limit and says so in a toast", () => {
    const t = setup();
    t.select([0, 0]);
    const long = "x".repeat(MAX_CELL_CHARS + 10);
    expect(t.interaction.paste(fakeData({ "text/plain": `${long}\tshort` }))).toBe(true);
    expect(t.raw(0, 0)).toHaveLength(MAX_CELL_CHARS);
    expect(t.raw(0, 1)).toBe("short");
    expect(t.toasts()).toEqual([CELL_TOO_LONG_MESSAGE]);
    expect(CELL_TOO_LONG_MESSAGE).toBe(
      "Some cells were longer than 32,767 characters and were cut",
    );
  });

  it("does not toast when every pasted cell fits", () => {
    const t = setup();
    t.select([0, 0]);
    t.interaction.paste(fakeData({ "text/plain": "x".repeat(MAX_CELL_CHARS) }));
    expect(t.raw(0, 0)).toHaveLength(MAX_CELL_CHARS);
    expect(t.toasts()).toEqual([]);
  });

  it("prefers our html payload over the plain text; foreign html falls back to the text", () => {
    const t = setup();
    t.select([0, 0]);
    t.interaction.paste(
      fakeData({ "text/html": "<table><tr><td>zzz</td></tr></table>", "text/plain": "plain" }),
    );
    expect(t.raw(0, 0)).toBe("plain");
  });

  it("is not handled for an empty clipboard", () => {
    const t = setup();
    t.select([0, 0]);
    expect(t.interaction.paste(fakeData())).toBe(false);
  });

  it("fills a whole selected range from a single copied cell, each target shifted", () => {
    const t = setup();
    t.put(0, 0, { v: 10 });
    t.put(0, 1, { f: "=A1+1" });
    t.select([0, 1]);
    const data = t.copy();
    t.select([2, 2], [4, 3]);
    t.interaction.paste(data);
    // source B1 is =A1+1; target (r,c) is shifted by (r-0, c-1)
    expect(t.raw(2, 2)).toBe("=B3+1");
    expect(t.raw(3, 2)).toBe("=B4+1");
    expect(t.raw(4, 3)).toBe("=C5+1");
    expect(t.txs).toEqual([LOCAL_ORIGIN]);
    expect(t.range()).toEqual({ start: t.c(2, 2), end: t.c(4, 3) });
    // external single value fills too
    t.select([8, 0], [9, 0]);
    t.interaction.paste(fakeData({ "text/plain": "q" }));
    expect([t.raw(8, 0), t.raw(9, 0)]).toEqual(["q", "q"]);
  });

  it("cuts data past the sheet and says so", () => {
    const t = setup();
    t.select([98, 24]);
    t.interaction.paste(fakeData({ "text/plain": "1\t2\t3\t4\n5\t6\t7\t8\n9\t10\t11\t12" }));
    expect(t.raw(98, 24)).toBe("1");
    expect(t.raw(99, 25)).toBe("6");
    expect(t.range()).toEqual({ start: t.c(98, 24), end: t.c(99, 25) });
    expect(t.toasts()).toEqual(["Pasted data was cut to fit the sheet"]);
    expect(t.txs).toHaveLength(1);
  });

  it("refuses a paste larger than the cell limit without writing", () => {
    const t = setup();
    t.select([0, 0]);
    const row = Array(26).fill("x").join("\t");
    const rows = Array(Math.floor(MAX_PASTE_CELLS / 26) + 1)
      .fill(row)
      .join("\n");
    expect(t.interaction.paste(fakeData({ "text/plain": rows }))).toBe(true);
    expect(t.txs).toHaveLength(0);
    expect(t.raw(0, 0)).toBe("");
    expect(t.toasts()[0]).toMatch(/too large/i);
  });

  it("is refused for viewers: handled, but nothing changes", () => {
    const t = setup({ readOnly: true });
    t.select([0, 0]);
    expect(t.interaction.paste(fakeData({ "text/plain": "hello" }))).toBe(true);
    expect(t.raw(0, 0)).toBe("");
    expect(t.txs).toHaveLength(0);
  });

  it("one paste is one undo step", () => {
    const t = setup();
    const undo = createWorkbookUndo(t.doc, {
      isReadOnly: () => false,
      getContext: () => ({ sheetId: t.sheetId, selection: null }),
    });
    t.select([0, 0]);
    t.interaction.paste(fakeData({ "text/plain": "1\t2\n3\t4" }));
    expect(undo.getState().canUndo).toBe(true);
    undo.undo();
    expect([t.raw(0, 0), t.raw(1, 1)]).toEqual(["", ""]);
    expect(undo.getState().canUndo).toBe(false);
    undo.redo();
    expect(t.raw(1, 1)).toBe("4");
    undo.destroy();
  });
});

describe("cut", () => {
  it("marks the source and moves on paste: stored formulas verbatim, source cleared, formats moved", () => {
    const t = setup();
    t.put(0, 0, { v: 1 });
    t.put(0, 1, { f: "=A1+10" });
    t.put(1, 1, { f: "=B1*2" }); // refers to the cut cell, must keep pointing at B1
    const rows = readRowOrder(t.doc, t.sheetId);
    const cols = readColOrder(t.doc, t.sheetId);
    t.doc.transact(() =>
      getFormatsMap(t.doc, t.sheetId).set(cellKey(rows[0]!, cols[1]!), { u: true }),
    );
    t.txs.length = 0;
    const storedBefore = getCell(t.doc, t.sheetId, rows[0]!, cols[1]!)!;

    t.select([0, 1]);
    const data = t.copy(true);
    expect(t.txs).toHaveLength(0);
    expect(t.store.getState().clipboard.cutMark).toEqual({
      sheetId: t.sheetId,
      range: {
        anchor: { rowId: rows[0], colId: cols[1] },
        focus: { rowId: rows[0], colId: cols[1] },
      },
    });
    expect(parseClipboardHtml(data.store["text/html"]!)!.cut).toBe(true);

    t.select([5, 5]);
    t.interaction.paste(data);
    expect(t.txs).toEqual([LOCAL_ORIGIN]);
    expect(getCell(t.doc, t.sheetId, rows[5]!, cols[5]!)).toEqual(storedBefore);
    expect(t.raw(5, 5)).toBe("=A1+10"); // unchanged, not shifted
    expect(t.shown(5, 5)).toBe("11");
    expect(getCell(t.doc, t.sheetId, rows[0]!, cols[1]!)).toBeUndefined();
    const formats = getFormatsMap(t.doc, t.sheetId);
    expect(formats.get(cellKey(rows[5]!, cols[5]!))).toEqual({ u: true });
    expect(formats.get(cellKey(rows[0]!, cols[1]!))).toBeUndefined();
    expect(t.store.getState().clipboard.cutMark).toBeNull();
    expect(t.range()).toEqual({ start: t.c(5, 5), end: t.c(5, 5) });
    // a second paste is now a plain copy-paste: shifted, source untouched
    t.select([7, 5]);
    t.interaction.paste(data);
    expect(t.raw(7, 5)).toBe("=E8+10"); // =A1+10 shifted by (7 rows, 4 cols)
  });

  it("overlapping source and destination keeps the destination", () => {
    const t = setup();
    for (let r = 0; r < 3; r++) t.put(r, 0, { v: r + 1 });
    t.select([0, 0], [2, 0]);
    const data = t.copy(true);
    t.select([1, 0]);
    t.interaction.paste(data);
    expect([0, 1, 2, 3].map((r) => t.raw(r, 0))).toEqual(["", "1", "2", "3"]);
  });

  it("moves in one undo step and undo restores the source", () => {
    const t = setup();
    const undo = createWorkbookUndo(t.doc, {
      isReadOnly: () => false,
      getContext: () => ({ sheetId: t.sheetId, selection: null }),
    });
    t.put(0, 0, { v: "x" });
    t.select([0, 0]);
    const data = t.copy(true);
    t.select([3, 3]);
    t.interaction.paste(data);
    expect([t.raw(0, 0), t.raw(3, 3)]).toEqual(["", "x"]);
    undo.undo();
    expect([t.raw(0, 0), t.raw(3, 3)]).toEqual(["x", ""]);
    undo.destroy();
  });

  it.each([
    ["Escape", (t: ReturnType<typeof setup>) => t.view.keyDown({ key: "Escape" })],
    [
      "an edit committed in a cell",
      (t: ReturnType<typeof setup>) => {
        t.select([9, 9]);
        t.view.keyDown({ key: "7" });
        t.interaction.commitEdit("7", null);
      },
    ],
    [
      "a local format change",
      (t: ReturnType<typeof setup>) =>
        t.doc.transact(
          () =>
            getFormatsMap(t.doc, t.sheetId).set(
              cellKey(readRowOrder(t.doc, t.sheetId)[9]!, readColOrder(t.doc, t.sheetId)[9]!),
              { b: true },
            ),
          LOCAL_ORIGIN,
        ),
    ],
    ["a new copy", (t: ReturnType<typeof setup>) => t.copy(false)],
  ])("%s clears the mark, and a later paste of the cut payload acts as a copy", (_name, clear) => {
    const t = setup();
    t.put(0, 0, { v: "x" });
    t.select([0, 0]);
    const data = t.copy(true);
    expect(t.store.getState().clipboard.cutMark).not.toBeNull();
    clear(t);
    expect(t.store.getState().clipboard.cutMark).toBeNull();
    t.select([3, 3]);
    t.interaction.paste(data);
    expect(t.raw(3, 3)).toBe("x");
    expect(t.raw(0, 0)).toBe("x"); // source stays: it was only a copy
  });

  it("a remote edit does not clear the mark", () => {
    const t = setup();
    t.put(0, 0, { v: "x" });
    t.select([0, 0]);
    t.copy(true);
    edit(t.doc, t.sheetId, 9, 9, { v: 1 }); // origin null = a collaborator
    expect(t.store.getState().clipboard.cutMark).not.toBeNull();
  });

  it("cut and paste across sheets keeps formulas pointing at the source sheet's cells", () => {
    const first = setup();
    first.put(0, 0, { v: 5 });
    first.put(0, 1, { f: "=A1*2" });
    const sheet2 = addSheet(first.doc, "Other");
    const second = setup({ doc: first.doc, sheetId: sheet2, store: first.store });
    first.select([0, 1]);
    const data = first.copy(true);
    second.select([2, 2]);
    second.interaction.paste(data);
    expect(second.raw(2, 2)).toBe("=Sheet1!A1*2");
    expect(second.shown(2, 2)).toBe("10");
    expect(first.raw(0, 1)).toBe("");
    expect(first.store.getState().clipboard.cutMark).toBeNull();
  });

  it("the mark does not follow into a pasted copy: copying leaves no mark", () => {
    const t = setup();
    t.select([0, 0]);
    t.copy(false);
    expect(t.store.getState().clipboard.cutMark).toBeNull();
  });
});
