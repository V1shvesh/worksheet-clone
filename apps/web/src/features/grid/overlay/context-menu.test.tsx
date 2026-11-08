import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Provider } from "react-redux";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { readColOrder, readRowOrder } from "@worksheet-clone/shared";
import { createStore } from "../../../app/store";
import { LOCAL_ORIGIN } from "../../../crdt/origin";
import { WorkbookDocContext } from "../../../crdt/WorkbookDoc";
import { createFormulaEngine } from "../../../engine";
import { edit, newDoc } from "../../../test-utils/workbook";
import { FakeGridView } from "../adapters/fake/fake-grid-view";
import type { StructureActions } from "../commands";
import { GridContainer } from "../GridContainer";
import { resolveSelection } from "../interaction";
import { SheetViewModel } from "../model";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(opts: { readOnly?: boolean } = {}) {
  const { doc, sheetId } = newDoc();
  const store = createStore();
  const view = new FakeGridView();
  const engine = createFormulaEngine(doc);
  const structure: StructureActions = {
    insertRows: vi.fn(),
    insertCols: vi.fn(),
    deleteRows: vi.fn(),
    deleteCols: vi.fn(),
  };
  const origins: unknown[] = [];
  doc.on("afterTransaction", (tr: Y.Transaction) => {
    if (tr.changed.size > 0) origins.push(tr.origin);
  });
  render(
    <Provider store={store}>
      <WorkbookDocContext.Provider value={{ doc, readOnly: opts.readOnly ?? false }}>
        <GridContainer
          sheetId={sheetId}
          engine={engine}
          createView={() => view}
          structure={structure}
        />
      </WorkbookDocContext.Provider>
    </Provider>,
  );
  const model = new SheetViewModel(doc, sheetId, engine);
  const selected = () => resolveSelection(store.getState().grid.selection, model)?.range;
  const menu = () => screen.queryByTestId("grid-context-menu");
  const open = (target: Parameters<FakeGridView["contextMenu"]>[0], x = 100, y = 80) =>
    act(() => view.contextMenu(target, x, y));
  const select = (a: [number, number], b: [number, number] = a) =>
    act(() => {
      view.pointerDown({ row: a[0], col: a[1] });
      if (a[0] !== b[0] || a[1] !== b[1]) view.pointerMove({ row: b[0], col: b[1] });
      view.pointerUp({ row: b[0], col: b[1] });
    });
  const rowHeaders = (a: number, b: number) =>
    act(() => {
      view.pointerDown({ kind: "rowHeader", row: a });
      view.pointerMove({ kind: "rowHeader", row: b });
      view.pointerUp({ kind: "rowHeader", row: b });
    });
  return {
    doc,
    sheetId,
    store,
    view,
    structure,
    origins,
    model,
    selected,
    menu,
    open,
    select,
    rowHeaders,
  };
}

const items = () => within(screen.getByTestId("grid-context-menu")).getAllByRole("menuitem");

describe("context menu", () => {
  it("opens at the pointer on a right-click and selects the clicked cell", () => {
    const t = setup();
    t.select([0, 0]);
    t.open({ row: 3, col: 2 }, 210, 140);
    const menu = screen.getByTestId("grid-context-menu");
    expect(menu).toHaveAttribute("role", "menu");
    expect(menu.style.left).toBe("210px");
    expect(menu.style.top).toBe("140px");
    expect(t.selected()).toEqual({ start: { row: 3, col: 2 }, end: { row: 3, col: 2 } });
    expect(items().map((i) => i.dataset.testid)).toEqual([
      "menu-insert-rows-above",
      "menu-insert-rows-below",
      "menu-insert-cols-left",
      "menu-insert-cols-right",
      "menu-delete-rows",
      "menu-delete-cols",
      "menu-clear",
    ]);
  });

  it("keeps a range selection when the click lands inside it", () => {
    const t = setup();
    t.select([1, 1], [4, 3]);
    t.open({ row: 2, col: 2 });
    expect(t.selected()).toEqual({ start: { row: 1, col: 1 }, end: { row: 4, col: 3 } });
    expect(screen.getByTestId("menu-insert-rows-above")).toHaveTextContent("Insert 4 rows above");
    expect(screen.getByTestId("menu-delete-cols")).toHaveTextContent("Delete columns B–D");
  });

  it("a click outside the selection replaces it", () => {
    const t = setup();
    t.select([1, 1], [4, 3]);
    t.open({ row: 8, col: 8 });
    expect(t.selected()).toEqual({ start: { row: 8, col: 8 }, end: { row: 8, col: 8 } });
  });

  it("a right-click on a row header selects the whole row and shows row items only", () => {
    const t = setup();
    t.select([5, 5]);
    t.open({ kind: "rowHeader", row: 2 });
    expect(t.selected()).toEqual({ start: { row: 2, col: 0 }, end: { row: 2, col: 25 } });
    expect(items().map((i) => i.dataset.testid)).toEqual([
      "menu-insert-rows-above",
      "menu-insert-rows-below",
      "menu-delete-rows",
      "menu-clear",
    ]);
    expect(screen.getByTestId("menu-delete-rows")).toHaveTextContent("Delete row 3");
  });

  it("a right-click on a column header selects the column; labels use the column letters", () => {
    const t = setup();
    t.open({ kind: "colHeader", col: 2 });
    expect(t.selected()).toEqual({ start: { row: 0, col: 2 }, end: { row: 99, col: 2 } });
    expect(screen.getByTestId("menu-delete-cols")).toHaveTextContent("Delete column C");
    expect(screen.getByTestId("menu-insert-cols-left")).toHaveTextContent("Insert 1 column left");
    expect(screen.queryByTestId("menu-delete-rows")).toBeNull();
  });

  it("right-clicking inside a multi-row header selection keeps it and counts the rows", () => {
    const t = setup();
    t.rowHeaders(1, 3);
    t.open({ kind: "rowHeader", row: 2 });
    expect(screen.getByTestId("menu-insert-rows-above")).toHaveTextContent("Insert 3 rows above");
    expect(screen.getByTestId("menu-delete-rows")).toHaveTextContent("Delete rows 2–4");
  });

  it("calls the injected handler with the right arguments", () => {
    const t = setup();
    const rows = readRowOrder(t.doc, t.sheetId);
    const cols = readColOrder(t.doc, t.sheetId);
    t.rowHeaders(1, 3);
    t.open({ kind: "rowHeader", row: 2 });
    fireEvent.click(screen.getByTestId("menu-insert-rows-below"));
    expect(t.structure.insertRows).toHaveBeenCalledWith(4, 3);
    expect(t.menu()).toBeNull();

    t.open({ kind: "rowHeader", row: 2 });
    fireEvent.click(screen.getByTestId("menu-delete-rows"));
    expect(t.structure.deleteRows).toHaveBeenCalledWith([rows[1], rows[2], rows[3]]);

    t.open({ kind: "colHeader", col: 4 });
    fireEvent.click(screen.getByTestId("menu-insert-cols-left"));
    expect(t.structure.insertCols).toHaveBeenCalledWith(4, 1);
    t.open({ kind: "colHeader", col: 4 });
    fireEvent.click(screen.getByTestId("menu-insert-cols-right"));
    expect(t.structure.insertCols).toHaveBeenCalledWith(5, 1);
    t.open({ kind: "colHeader", col: 4 });
    fireEvent.click(screen.getByTestId("menu-delete-cols"));
    expect(t.structure.deleteCols).toHaveBeenCalledWith([cols[4]]);
    // Structure edits go to the handler, never straight into the doc.
    expect(t.origins).toEqual([]);
  });

  it("Clear contents clears the selection in one transaction", () => {
    const t = setup();
    edit(t.doc, t.sheetId, 0, 0, { v: 1 });
    edit(t.doc, t.sheetId, 1, 0, { v: 2 });
    edit(t.doc, t.sheetId, 2, 0, { v: 3 });
    t.origins.length = 0;
    t.select([0, 0], [1, 0]);
    t.open({ row: 1, col: 0 });
    fireEvent.click(screen.getByTestId("menu-clear"));
    expect(t.model.getRawInput({ row: 0, col: 0 })).toBe("");
    expect(t.model.getRawInput({ row: 1, col: 0 })).toBe("");
    expect(t.model.getRawInput({ row: 2, col: 0 })).toBe("3");
    expect(t.origins).toEqual([LOCAL_ORIGIN]);
    expect(t.menu()).toBeNull();
  });

  it("disables every item for a viewer, and clicking changes nothing", () => {
    const t = setup({ readOnly: true });
    edit(t.doc, t.sheetId, 0, 0, { v: 1 });
    t.origins.length = 0;
    t.open({ row: 0, col: 0 });
    for (const item of items()) expect(item).toBeDisabled();
    fireEvent.click(screen.getByTestId("menu-clear"));
    fireEvent.click(screen.getByTestId("menu-insert-rows-above"));
    expect(t.model.getRawInput({ row: 0, col: 0 })).toBe("1");
    expect(t.origins).toEqual([]);
    expect(t.structure.insertRows).not.toHaveBeenCalled();
  });

  it("disables delete when the selection covers every row or column", () => {
    const t = setup();
    act(() => {
      t.view.pointerDown({ kind: "corner" });
      t.view.pointerUp({ kind: "corner" });
    });
    t.open({ row: 0, col: 0 });
    expect(screen.getByTestId("menu-delete-rows")).toBeDisabled();
    expect(screen.getByTestId("menu-delete-cols")).toBeDisabled();
    fireEvent.click(screen.getByTestId("menu-delete-rows"));
    expect(t.structure.deleteRows).not.toHaveBeenCalled();
    expect(screen.getByTestId("menu-insert-rows-above")).toBeEnabled();
  });

  it("stays inside the viewport", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 200,
      height: 150,
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 150,
      toJSON: () => ({}),
    });
    const t = setup();
    t.open({ row: 1, col: 1 }, window.innerWidth - 5, window.innerHeight - 5);
    const menu = screen.getByTestId("grid-context-menu");
    expect(parseFloat(menu.style.left)).toBe(window.innerWidth - 200 - 4);
    expect(parseFloat(menu.style.top)).toBe(window.innerHeight - 150 - 4);
    t.open({ row: 1, col: 1 }, -50, -20);
    expect(parseFloat(menu.style.left)).toBe(4);
    expect(parseFloat(menu.style.top)).toBe(4);
  });

  describe("closing", () => {
    it("closes on Escape and gives focus back to the grid", () => {
      const t = setup();
      t.open({ row: 1, col: 1 });
      const before = t.view.focusCount;
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      expect(t.menu()).toBeNull();
      expect(t.view.focusCount).toBeGreaterThan(before);
    });

    it("closes on an outside press but not on a press inside it", () => {
      const t = setup();
      t.open({ row: 1, col: 1 });
      fireEvent.pointerDown(screen.getByTestId("menu-clear"));
      expect(t.menu()).not.toBeNull();
      fireEvent.pointerDown(document.body);
      expect(t.menu()).toBeNull();
    });

    it("closes when the grid scrolls", () => {
      const t = setup();
      t.open({ row: 1, col: 1 });
      act(() => t.view.scrollTo(0, 200));
      expect(t.menu()).toBeNull();
    });

    it("choosing an item closes it and refocuses the grid", () => {
      const t = setup();
      t.open({ row: 1, col: 1 });
      const before = t.view.focusCount;
      fireEvent.click(screen.getByTestId("menu-insert-rows-above"));
      expect(t.menu()).toBeNull();
      expect(t.view.focusCount).toBeGreaterThan(before);
    });

    it("a second right-click moves the menu instead of stacking another", () => {
      const t = setup();
      t.open({ row: 1, col: 1 }, 10, 10);
      t.open({ row: 5, col: 5 }, 300, 200);
      expect(screen.getAllByTestId("grid-context-menu")).toHaveLength(1);
      expect(screen.getByTestId("grid-context-menu").style.left).toBe("300px");
    });
  });

  describe("keyboard", () => {
    it("focuses the first item; arrows move and wrap; disabled items are skipped", () => {
      const t = setup();
      // Every row selected: Delete rows is disabled, so navigation must skip it.
      t.rowHeaders(0, 99);
      t.open({ kind: "rowHeader", row: 5 });
      const menu = screen.getByTestId("grid-context-menu");
      expect(screen.getByTestId("menu-delete-rows")).toBeDisabled();
      expect(document.activeElement).toBe(screen.getByTestId("menu-insert-rows-above"));
      const focusedAfter = (key: string) => {
        fireEvent.keyDown(menu, { key });
        return (document.activeElement as HTMLElement).dataset.testid;
      };
      expect(focusedAfter("ArrowDown")).toBe("menu-insert-rows-below");
      expect(focusedAfter("ArrowDown")).toBe("menu-insert-cols-left");
      expect(focusedAfter("ArrowDown")).toBe("menu-insert-cols-right");
      // Both delete items are disabled, so the next stop is Clear.
      expect(focusedAfter("ArrowDown")).toBe("menu-clear");
      expect(focusedAfter("ArrowDown")).toBe("menu-insert-rows-above");
      fireEvent.keyDown(menu, { key: "ArrowUp" });
      expect(document.activeElement).toBe(screen.getByTestId("menu-clear"));
      fireEvent.keyDown(menu, { key: "Home" });
      expect(document.activeElement).toBe(screen.getByTestId("menu-insert-rows-above"));
      fireEvent.keyDown(menu, { key: "End" });
      expect(document.activeElement).toBe(screen.getByTestId("menu-clear"));
    });

    it("Enter activates the focused item (a button click)", () => {
      const t = setup();
      t.open({ row: 2, col: 2 });
      const menu = screen.getByTestId("grid-context-menu");
      fireEvent.keyDown(menu, { key: "ArrowDown" });
      const focused = document.activeElement as HTMLElement;
      expect(focused).toBe(screen.getByTestId("menu-insert-rows-below"));
      // jsdom does not turn Enter into a click on a button; this is what a browser does.
      fireEvent.click(focused);
      expect(t.structure.insertRows).toHaveBeenCalledWith(3, 1);
    });
  });
});
