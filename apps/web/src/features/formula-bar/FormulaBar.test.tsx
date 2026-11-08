import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { getCell, readColOrder, readRowOrder } from "@worksheet-clone/shared";
import { createStore } from "../../app/store";
import { LOCAL_ORIGIN } from "../../crdt/origin";
import { WorkbookDocContext } from "../../crdt/WorkbookDoc";
import { createFormulaEngine } from "../../engine";
import { asRemote } from "../../test-utils/render-workbook";
import { edit, newDoc } from "../../test-utils/workbook";
import { FakeGridView } from "../grid/adapters/fake/fake-grid-view";
import { GridContainer } from "../grid/GridContainer";

afterEach(cleanup);

function setup(opts: { readOnly?: boolean } = {}) {
  const { doc, sheetId } = newDoc();
  const store = createStore();
  const view = new FakeGridView();
  const engine = createFormulaEngine(doc);
  const origins: unknown[] = [];
  doc.on("afterTransaction", (tr: Y.Transaction) => {
    if (tr.changed.size > 0) origins.push(tr.origin);
  });
  render(
    <Provider store={store}>
      <WorkbookDocContext.Provider value={{ doc, readOnly: opts.readOnly ?? false }}>
        <GridContainer sheetId={sheetId} engine={engine} createView={() => view} />
      </WorkbookDocContext.Provider>
    </Provider>,
  );
  const stored = (row: number, col: number) =>
    getCell(doc, sheetId, readRowOrder(doc, sheetId)[row]!, readColOrder(doc, sheetId)[col]!);
  return {
    doc,
    sheetId,
    store,
    view,
    origins,
    stored,
    bar: () => screen.getByLabelText("Formula bar") as HTMLInputElement,
    nameBox: () => screen.getByTestId("name-box"),
    click(row: number, col: number) {
      act(() => {
        view.pointerDown({ row, col });
        view.pointerUp({ row, col });
      });
    },
  };
}

describe("name box", () => {
  it("shows the cell, a range, a whole column and a whole row", () => {
    const s = setup();
    expect(s.nameBox().textContent).toBe("");
    s.click(1, 2);
    expect(s.nameBox().textContent).toBe("C2");
    act(() => {
      s.view.pointerDown({ row: 1, col: 2 }, { shiftKey: true });
      s.view.pointerMove({ row: 4, col: 3 });
      s.view.pointerUp({ row: 4, col: 3 });
    });
    expect(s.nameBox().textContent).toBe("C2:D5");
    act(() => {
      s.view.pointerDown({ kind: "colHeader", col: 0 });
      s.view.pointerUp(null);
    });
    expect(s.nameBox().textContent).toBe("A:A");
    act(() => {
      s.view.pointerDown({ kind: "rowHeader", row: 2 });
      s.view.pointerUp(null);
    });
    expect(s.nameBox().textContent).toBe("3:3");
  });
});

describe("formula bar", () => {
  it("shows the active cell's raw input, formulas as A1, and follows remote changes", () => {
    const s = setup();
    act(() => {
      edit(s.doc, s.sheetId, 0, 0, { v: 1 });
      edit(s.doc, s.sheetId, 0, 1, { f: "=A1*2" });
    });
    s.click(0, 1);
    expect(s.bar().value).toBe("=A1*2");
    s.click(0, 0);
    expect(s.bar().value).toBe("1");
    act(() => asRemote(s.doc, () => edit(s.doc, s.sheetId, 0, 0, { v: "changed" })));
    expect(s.bar().value).toBe("changed");
  });

  it("focusing starts an edit; typing updates the draft and the floating editor shows it", () => {
    const s = setup();
    act(() => edit(s.doc, s.sheetId, 0, 0, { v: 5 }));
    s.click(0, 0);
    act(() => s.bar().focus());
    expect(s.store.getState().grid.editing).toMatchObject({
      draft: "5",
      mode: "edit",
      source: "bar",
    });
    fireEvent.change(s.bar(), { target: { value: "=A2+1" } });
    expect(s.store.getState().grid.editing?.draft).toBe("=A2+1");
    const editor = screen.getByTestId("cell-editor") as HTMLInputElement;
    expect(editor.value).toBe("=A2+1");
    // The bar keeps DOM focus: the cell editor must not steal it (or keystrokes would double).
    expect(s.bar()).toHaveFocus();
    expect(s.origins).toHaveLength(1); // only the seed edit
  });

  it("typing in the cell editor updates the bar", () => {
    const s = setup();
    s.click(0, 0);
    act(() => s.view.keyDown({ key: "h" }));
    fireEvent.change(screen.getByTestId("cell-editor"), { target: { value: "hey" } });
    expect(s.bar().value).toBe("hey");
    expect(screen.getByTestId("cell-editor")).toHaveFocus();
  });

  it("Enter commits one LOCAL transaction, moves down and returns focus to the grid", () => {
    const s = setup();
    s.click(0, 0);
    act(() => s.bar().focus());
    fireEvent.change(s.bar(), { target: { value: "42" } });
    const before = s.view.focusCount;
    fireEvent.keyDown(s.bar(), { key: "Enter" });
    expect(s.stored(0, 0)).toEqual({ v: 42 });
    expect(s.origins).toEqual([LOCAL_ORIGIN]);
    expect(s.store.getState().grid.editing).toBeNull();
    expect(s.nameBox().textContent).toBe("A2");
    expect(s.view.focusCount).toBeGreaterThan(before);
    expect(screen.queryByTestId("cell-editor")).toBeNull();
  });

  it("Tab commits and moves right; Escape cancels without writing", () => {
    const s = setup();
    s.click(0, 0);
    act(() => s.bar().focus());
    fireEvent.change(s.bar(), { target: { value: "7" } });
    fireEvent.keyDown(s.bar(), { key: "Tab" });
    expect(s.stored(0, 0)).toEqual({ v: 7 });
    expect(s.nameBox().textContent).toBe("B1");

    act(() => s.bar().focus());
    fireEvent.change(s.bar(), { target: { value: "nope" } });
    fireEvent.keyDown(s.bar(), { key: "Escape" });
    expect(s.stored(0, 1)).toBeUndefined();
    expect(s.store.getState().grid.editing).toBeNull();
    expect(s.bar().value).toBe("");
  });

  it("a remote change to the active cell does not clobber the draft being typed", () => {
    const s = setup();
    s.click(0, 0);
    act(() => s.bar().focus());
    fireEvent.change(s.bar(), { target: { value: "mine" } });
    act(() => asRemote(s.doc, () => edit(s.doc, s.sheetId, 0, 0, { v: "theirs" })));
    expect(s.bar().value).toBe("mine");
    fireEvent.keyDown(s.bar(), { key: "Enter" });
    expect(s.stored(0, 0)).toEqual({ v: "mine" });
  });

  it("is read-only for viewers: no edit starts", () => {
    const s = setup({ readOnly: true });
    act(() => edit(s.doc, s.sheetId, 0, 0, { v: 3 }));
    s.click(0, 0);
    expect(s.bar().value).toBe("3");
    expect(s.bar().readOnly).toBe(true);
    act(() => s.bar().focus());
    expect(s.store.getState().grid.editing).toBeNull();
  });

  it("is read-only until something is selected", () => {
    const s = setup();
    expect(s.bar().readOnly).toBe(true);
  });
});
