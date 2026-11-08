import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  addSheet as addSheetToDoc,
  cellKey,
  getCell,
  getFormatsMap,
  readColOrder,
  readRowOrder,
} from "@worksheet-clone/shared";
import type * as Y from "yjs";
import { LOCAL_ORIGIN } from "../../crdt/origin";
import { setCellContent } from "../../crdt/mutations";
import { asRemote, renderWithWorkbook } from "../../test-utils/render-workbook";
import { newDoc } from "../../test-utils/workbook";
import { gridActions } from "../grid/gridSlice";
import { Toolbar } from "./Toolbar";

afterEach(cleanup);

function value(doc: ReturnType<typeof newDoc>["doc"], sheetId: string, row: number) {
  return getCell(doc, sheetId, readRowOrder(doc, sheetId)[row]!, readColOrder(doc, sheetId)[0]!)?.v;
}
function write(doc: ReturnType<typeof newDoc>["doc"], sheetId: string, row: number, v: number) {
  act(() => {
    setCellContent(
      doc,
      false,
      sheetId,
      readRowOrder(doc, sheetId)[row]!,
      readColOrder(doc, sheetId)[0]!,
      { v },
    );
  });
}

describe("Toolbar undo/redo", () => {
  it("buttons follow the stacks and undo/redo your edits", () => {
    const { doc, sheetId } = newDoc();
    renderWithWorkbook(<Toolbar />, { doc, route: `/workbooks/w1?sheet=${sheetId}` });
    const undo = screen.getByRole<HTMLButtonElement>("button", { name: "Undo" });
    const redo = screen.getByRole<HTMLButtonElement>("button", { name: "Redo" });
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(true);
    write(doc, sheetId, 0, 5);
    expect(undo.disabled).toBe(false);
    fireEvent.click(undo);
    expect(value(doc, sheetId, 0)).toBeUndefined();
    expect(undo.disabled).toBe(true);
    expect(redo.disabled).toBe(false);
    fireEvent.click(redo);
    expect(value(doc, sheetId, 0)).toBe(5);
  });

  it("is disabled for viewers and never undoes", () => {
    const { doc, sheetId } = newDoc();
    const view = renderWithWorkbook(<Toolbar />, { doc, route: `/workbooks/w1?sheet=${sheetId}` });
    write(doc, sheetId, 0, 5);
    view.setReadOnly(true);
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
    view.setReadOnly(false);
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("a collaborator's edit does not enable undo", () => {
    const { doc, sheetId } = newDoc();
    renderWithWorkbook(<Toolbar />, { doc, route: `/workbooks/w1?sheet=${sheetId}` });
    act(() => doc.transact(() => undefined, "remote"));
    expect((screen.getByRole("button", { name: "Undo" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("cancels an open edit, switches to the action's sheet and restores its selection", () => {
    const { doc, sheetId: first } = newDoc();
    let second = "";
    act(() => {
      doc.transact(() => {
        second = addSheetToDoc(doc, "Other");
      }, "remote");
    });
    const view = renderWithWorkbook(<Toolbar />, { doc, route: `/workbooks/w1?sheet=${first}` });
    const { store } = view;
    const rowId = readRowOrder(doc, second)[3]!;
    const colId = readColOrder(doc, second)[2]!;
    const selection = { anchor: { rowId, colId }, focus: { rowId, colId } };
    // The user acted on the second sheet with this selection...
    act(() => {
      store.dispatch(gridActions.sheetOpened(second));
      store.dispatch(gridActions.selectionChanged(selection));
    });
    write(doc, second, 3, 7);
    // ...then moved to the first sheet and started typing.
    act(() => {
      store.dispatch(gridActions.sheetClosed());
      store.dispatch(gridActions.sheetOpened(first));
      store.dispatch(
        gridActions.editingStarted({
          rowId: readRowOrder(doc, first)[0]!,
          colId,
          draft: "x",
          mode: "typing",
        }),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(store.getState().grid.editing).toBeNull();
    expect(screen.getByTestId("location").textContent).toContain(`sheet=${second}`);
    expect(store.getState().grid.restore).toEqual({ sheetId: second, selection });
    // The second sheet's grid opening picks the selection up.
    act(() => {
      store.dispatch(gridActions.sheetClosed());
      store.dispatch(gridActions.sheetOpened(second));
    });
    expect(store.getState().grid.selection).toEqual(selection);
    expect(store.getState().grid.restore).toBeNull();
  });
});

describe("Toolbar formatting", () => {
  function setup(opts: { readOnly?: boolean } = {}) {
    const { doc, sheetId } = newDoc();
    const view = renderWithWorkbook(<Toolbar />, {
      doc,
      route: `/workbooks/w1?sheet=${sheetId}`,
      ...opts,
    });
    const rows = readRowOrder(doc, sheetId);
    const cols = readColOrder(doc, sheetId);
    const select = (r1: number, c1: number, r2 = r1, c2 = c1) =>
      act(() => {
        view.store.dispatch(gridActions.sheetOpened(sheetId));
        view.store.dispatch(
          gridActions.selectionChanged({
            anchor: { rowId: rows[r1]!, colId: cols[c1]! },
            focus: { rowId: rows[r2]!, colId: cols[c2]! },
          }),
        );
      });
    const origins: unknown[] = [];
    doc.on("afterTransaction", (tr: Y.Transaction) => {
      if (tr.changed.size > 0) origins.push(tr.origin);
    });
    const button = (name: string) => screen.getByRole<HTMLButtonElement>("button", { name });
    const format = (r: number, c: number) =>
      getFormatsMap(doc, sheetId).get(cellKey(rows[r]!, cols[c]!));
    return { doc, sheetId, select, origins, button, format, ...view };
  }

  it("buttons are disabled without a selection and for viewers", () => {
    const s = setup();
    expect(s.button("Bold").disabled).toBe(true);
    expect(s.button("Fill color").disabled).toBe(true);
    s.select(0, 0);
    expect(s.button("Bold").disabled).toBe(false);
    s.setReadOnly(true);
    expect(s.button("Bold").disabled).toBe(true);
    expect(s.button("Italic").disabled).toBe(true);
    expect(s.button("Underline").disabled).toBe(true);
    expect(s.button("Fill color").disabled).toBe(true);
  });

  it("a click formats the whole selection in one transaction, and undo reverts it in one step", () => {
    const s = setup();
    s.select(0, 0, 2, 1);
    fireEvent.click(s.button("Bold"));
    expect(s.origins).toEqual([LOCAL_ORIGIN]);
    expect(s.format(2, 1)).toEqual({ b: true });
    expect(s.button("Bold").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(s.button("Undo"));
    expect(s.format(2, 1)).toBeUndefined();
    expect(s.button("Bold").getAttribute("aria-pressed")).toBe("false");
  });

  it("aria-pressed follows the active cell and remote changes", () => {
    const s = setup();
    s.select(0, 0);
    expect(s.button("Italic").getAttribute("aria-pressed")).toBe("false");
    act(() =>
      asRemote(s.doc, () =>
        getFormatsMap(s.doc, s.sheetId).set(
          cellKey(readRowOrder(s.doc, s.sheetId)[0]!, readColOrder(s.doc, s.sheetId)[0]!),
          { i: true },
        ),
      ),
    );
    expect(s.button("Italic").getAttribute("aria-pressed")).toBe("true");
    s.select(1, 1);
    expect(s.button("Italic").getAttribute("aria-pressed")).toBe("false");
  });

  it("fill color: ten swatches plus None, applies and removes", () => {
    const s = setup();
    s.select(0, 0, 1, 0);
    fireEvent.click(s.button("Fill color"));
    expect(
      screen.getAllByRole("button").filter((b) => b.classList.contains("toolbar-swatch")),
    ).toHaveLength(10);
    fireEvent.click(s.button("Yellow"));
    expect(s.format(1, 0)).toEqual({ bg: "#fff2a8" });
    expect(screen.queryByRole("button", { name: "Yellow" })).toBeNull();
    fireEvent.click(s.button("Fill color"));
    expect(s.button("Yellow").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(s.format(0, 0)).toBeUndefined();
    expect(s.origins).toHaveLength(2);
  });

  it("Escape closes the fill popover", () => {
    const s = setup();
    s.select(0, 0);
    fireEvent.click(s.button("Fill color"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Fill colors" })).toBeNull();
  });
});
