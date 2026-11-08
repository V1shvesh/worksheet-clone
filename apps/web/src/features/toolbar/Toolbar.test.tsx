import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  addSheet as addSheetToDoc,
  getCell,
  readColOrder,
  readRowOrder,
} from "@worksheet-clone/shared";
import { setCellContent } from "../../crdt/mutations";
import { renderWithWorkbook } from "../../test-utils/render-workbook";
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
