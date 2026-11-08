import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Y from "yjs";
import { createStore } from "../../app/store";
import { LOCAL_ORIGIN } from "../../crdt/origin";
import { WorkbookDocContext } from "../../crdt/WorkbookDoc";
import { edit, newDoc } from "../../test-utils/workbook";
import { FakeGridView } from "./adapters/fake/fake-grid-view";
import { GridContainer } from "./GridContainer";
import { resolveSelection } from "./interaction";
import { SheetViewModel } from "./model";
import { createFormulaEngine } from "../../engine";

afterEach(cleanup);

function setup(opts: { readOnly?: boolean } = {}) {
  const { doc, sheetId } = newDoc();
  const store = createStore();
  const view = new FakeGridView();
  const engine = createFormulaEngine(doc);
  let localTransactions = 0;
  doc.on("afterTransaction", (tr: Y.Transaction) => {
    if (tr.origin === LOCAL_ORIGIN) localTransactions++;
  });
  const tree = (readOnly: boolean) => (
    <Provider store={store}>
      <WorkbookDocContext.Provider value={{ doc, readOnly }}>
        <GridContainer sheetId={sheetId} engine={engine} createView={() => view} />
      </WorkbookDocContext.Provider>
    </Provider>
  );
  const utils = render(tree(opts.readOnly ?? false));
  // A second model over the same doc, only to translate ids for assertions.
  const model = new SheetViewModel(doc, sheetId, engine);
  return {
    doc,
    sheetId,
    store,
    view,
    model,
    ...utils,
    rerenderWith: (readOnly: boolean) => utils.rerender(tree(readOnly)),
    transactions: () => localTransactions,
    selected: () => resolveSelection(store.getState().grid.selection, model),
  };
}

const press = (view: FakeGridView, key: string) => act(() => view.keyDown({ key }));
const click = (view: FakeGridView, row: number, col: number) =>
  act(() => {
    view.pointerDown({ row, col });
    view.pointerUp({ row, col });
  });
const px = (el: HTMLElement) => ({
  left: parseFloat(el.style.left),
  top: parseFloat(el.style.top),
  width: parseFloat(el.style.width),
  height: parseFloat(el.style.height),
});

describe("overlay geometry", () => {
  it("draws the active cell and range at getCellRect positions and follows scroll", () => {
    const { view } = setup();
    click(view, 2, 1);
    const rect = view.getCellRect({ row: 2, col: 1 })!;
    expect(px(screen.getByTestId("active-cell"))).toEqual({
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
    });

    act(() => {
      view.pointerDown({ row: 2, col: 1 });
      view.pointerMove({ row: 4, col: 3 });
      view.pointerUp({ row: 4, col: 3 });
    });
    const a = view.getCellRect({ row: 2, col: 1 })!;
    const b = view.getCellRect({ row: 4, col: 3 })!;
    expect(px(screen.getByTestId("selection-rect"))).toEqual({
      left: a.x,
      top: a.y,
      width: b.x + b.width - a.x,
      height: b.y + b.height - a.y,
    });

    act(() => view.scrollTo(0, 24));
    expect(px(screen.getByTestId("selection-rect")).top).toBe(a.y - 24);
    // The anchor (press point) stays the active cell after a drag, as in Excel/Sheets.
    expect(px(screen.getByTestId("active-cell")).top).toBe(a.y - 24);
  });

  it("clips a partly visible range and hides it when nothing is visible", () => {
    const { view } = setup();
    act(() => {
      view.pointerDown({ row: 1, col: 0 });
      view.pointerMove({ row: 90, col: 0 });
      view.pointerUp({ row: 90, col: 0 });
    });
    const visible = view.getVisibleRange();
    const last = view.getCellRect(visible.end)!;
    const sel = px(screen.getByTestId("selection-rect"));
    expect(sel.top + sel.height).toBe(last.y + last.height);

    // Focus (row 90) is still on screen, but a range of rows 1-3 is not.
    click(view, 1, 0);
    act(() => {
      view.pointerDown({ row: 1, col: 0 });
      view.pointerMove({ row: 3, col: 0 });
      view.pointerUp({ row: 3, col: 0 });
    });
    expect(screen.getByTestId("selection-rect")).toBeInTheDocument();
    act(() => view.scrollTo(0, 24 * 60));
    expect(screen.queryByTestId("selection-rect")).toBeNull();
    expect(screen.queryByTestId("active-cell")).toBeNull();
  });

  it("recomputes on window resize", () => {
    const { view } = setup();
    click(view, 0, 0);
    const spy = vi.spyOn(view, "getCellRect");
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(spy).toHaveBeenCalled();
  });
});

describe("cell editor", () => {
  it("opens on typing with the typed character, then follows the draft", () => {
    const { view, store } = setup();
    click(view, 0, 0);
    expect(screen.queryByTestId("cell-editor")).toBeNull();
    press(view, "h");
    const editor = screen.getByTestId("cell-editor") as HTMLInputElement;
    expect(editor.value).toBe("h");
    expect(editor).toHaveFocus();
    fireEvent.change(editor, { target: { value: "hi" } });
    expect(store.getState().grid.editing?.draft).toBe("hi");
    expect(editor.value).toBe("hi");
  });

  it("opens on F2 with the cell's raw input", () => {
    const { view, doc, sheetId } = setup();
    act(() => edit(doc, sheetId, 0, 0, { v: "abc" }));
    click(view, 0, 0);
    press(view, "F2");
    expect((screen.getByTestId("cell-editor") as HTMLInputElement).value).toBe("abc");
  });

  it("Enter commits exactly once, moves down, closes and refocuses the grid", () => {
    const { view, doc, sheetId, transactions, selected } = setup();
    click(view, 0, 0);
    press(view, "4");
    const editor = screen.getByTestId("cell-editor");
    fireEvent.change(editor, { target: { value: "42" } });
    const focusBefore = view.focusCount;
    fireEvent.keyDown(editor, { key: "Enter" });

    expect(transactions()).toBe(1);
    expect(screen.queryByTestId("cell-editor")).toBeNull();
    expect(view.displayedText({ row: 0, col: 0 })).toBe("42");
    expect(selected()?.focus).toEqual({ row: 1, col: 0 });
    expect(view.focusCount).toBe(focusBefore + 1);
    expect(doc.getMap("sheets").has(sheetId)).toBe(true);
  });

  it("Escape cancels with no transaction", () => {
    const { view, transactions, selected } = setup();
    click(view, 0, 0);
    press(view, "x");
    fireEvent.keyDown(screen.getByTestId("cell-editor"), { key: "Escape" });
    expect(transactions()).toBe(0);
    expect(screen.queryByTestId("cell-editor")).toBeNull();
    expect(selected()?.focus).toEqual({ row: 0, col: 0 });
    expect(view.displayedText({ row: 0, col: 0 })).toBe("");
  });

  it("Tab commits and moves right; Shift+Enter commits and moves up", () => {
    const { view, transactions, selected } = setup();
    click(view, 3, 3);
    press(view, "a");
    fireEvent.keyDown(screen.getByTestId("cell-editor"), { key: "Tab" });
    expect(transactions()).toBe(1);
    expect(selected()?.focus).toEqual({ row: 3, col: 4 });
    press(view, "b");
    fireEvent.keyDown(screen.getByTestId("cell-editor"), { key: "Enter", shiftKey: true });
    expect(transactions()).toBe(2);
    expect(selected()?.focus).toEqual({ row: 2, col: 4 });
  });

  it("clicking another cell commits the edit once", () => {
    const { view, transactions, selected } = setup();
    click(view, 0, 0);
    press(view, "z");
    click(view, 5, 5);
    expect(transactions()).toBe(1);
    expect(screen.queryByTestId("cell-editor")).toBeNull();
    expect(selected()?.focus).toEqual({ row: 5, col: 5 });
  });

  it("a collaborator's change to the edited cell does not touch the draft", () => {
    const { view, doc, sheetId } = setup();
    click(view, 0, 0);
    press(view, "m");
    const editor = screen.getByTestId("cell-editor") as HTMLInputElement;
    fireEvent.change(editor, { target: { value: "mine" } });
    act(() => doc.transact(() => edit(doc, sheetId, 0, 0, { v: "theirs" }), "remote"));
    expect(view.displayedText({ row: 0, col: 0 })).toBe("theirs");
    expect(editor.value).toBe("mine");
  });

  it("is never shown to a viewer, and closes if access is revoked mid-edit", () => {
    const viewer = setup({ readOnly: true });
    click(viewer.view, 0, 0);
    press(viewer.view, "a");
    expect(screen.queryByTestId("cell-editor")).toBeNull();
    cleanup();

    const s = setup();
    click(s.view, 0, 0);
    press(s.view, "a");
    expect(screen.getByTestId("cell-editor")).toBeInTheDocument();
    s.rerenderWith(true);
    expect(screen.queryByTestId("cell-editor")).toBeNull();
    expect(s.store.getState().grid.editing).toBeNull();
    expect(s.transactions()).toBe(0);
  });
});

describe("lifecycle", () => {
  it("unmount disposes the view, listeners and Redux grid state", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { view, doc, sheetId, store, unmount } = setup();
    click(view, 0, 0);
    expect(store.getState().grid.sheetId).toBe(sheetId);
    unmount();

    expect(store.getState().grid.sheetId).toBeNull();
    expect(() => view.focus()).toThrow(/after destroy/);
    // A leaked model/connect subscription would call refreshCells on the destroyed view.
    expect(() => act(() => edit(doc, sheetId, 0, 0, { v: 1 }))).not.toThrow();
    const count = (spy: typeof add, type: string) =>
      spy.mock.calls.filter(([t]) => t === type).length;
    expect(count(remove, "resize")).toBe(count(add, "resize"));
    add.mockRestore();
    remove.mockRestore();
  });
});

describe("native clipboard events", () => {
  const clipboardEvent = (type: string, store: Record<string, string>) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: {
        getData: (t: string) => store[t] ?? "",
        setData: (t: string, v: string) => {
          store[t] = v;
        },
      },
    });
    return event;
  };

  it("copy and paste on the grid's mount are handled and default-prevented", () => {
    const { view, doc, sheetId, container } = setup();
    act(() => edit(doc, sheetId, 0, 0, { v: 4 }));
    click(view, 0, 0);
    const mount = container.querySelector(".grid-mount")!;
    const data: Record<string, string> = {};
    const copy = clipboardEvent("copy", data);
    act(() => void mount.dispatchEvent(copy));
    expect(copy.defaultPrevented).toBe(true);
    expect(data["text/plain"]).toBe("4");

    click(view, 3, 3);
    const paste = clipboardEvent("paste", data);
    act(() => void mount.dispatchEvent(paste));
    expect(paste.defaultPrevented).toBe(true);
    expect(view.displayedText({ row: 3, col: 3 })).toBe("4");
  });

  it("cut draws a dashed outline over the source until Escape", () => {
    const { view, container } = setup();
    click(view, 1, 1);
    act(
      () => void container.querySelector(".grid-mount")!.dispatchEvent(clipboardEvent("cut", {})),
    );
    const rect = view.getCellRect({ row: 1, col: 1 })!;
    expect(px(screen.getByTestId("cut-rect"))).toEqual({
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
    });
    press(view, "Escape");
    expect(screen.queryByTestId("cut-rect")).toBeNull();
  });

  it("is left to the browser while a cell is being edited", () => {
    const { view, container } = setup();
    click(view, 0, 0);
    press(view, "a");
    const copy = clipboardEvent("copy", {});
    act(() => void container.querySelector(".grid-mount")!.dispatchEvent(copy));
    expect(copy.defaultPrevented).toBe(false);
  });
});

describe("fill handle", () => {
  // jsdom has no PointerEvent: a MouseEvent with a pointer type name carries clientX/clientY,
  // which is all the handle reads.
  const pointer = (
    el: Element,
    type: "pointerdown" | "pointermove" | "pointerup",
    at: { clientX?: number; clientY?: number } = {},
  ) =>
    act(() => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...at });
      Object.defineProperty(event, "pointerId", { value: 1 });
      el.dispatchEvent(event);
    });
  const centre = (view: FakeGridView, row: number, col: number) => {
    const rect = view.getCellRect({ row, col })!;
    return { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
  };

  it("sits on the selection's bottom-right corner and follows scroll", () => {
    const { view } = setup();
    click(view, 1, 1);
    const handle = screen.getByTestId("fill-handle");
    const rect = view.getCellRect({ row: 1, col: 1 })!;
    expect(parseFloat(handle.style.left) + parseFloat(handle.style.width) / 2).toBeCloseTo(
      rect.x + rect.width,
      0,
    );
    expect(parseFloat(handle.style.top) + parseFloat(handle.style.height) / 2).toBeCloseTo(
      rect.y + rect.height,
      0,
    );
    act(() => view.scrollTo(0, 5000));
    expect(screen.queryByTestId("fill-handle")).toBeNull(); // the corner is off-screen
  });

  it("is hidden for viewers and while editing", () => {
    const viewer = setup({ readOnly: true });
    click(viewer.view, 1, 1);
    expect(screen.queryByTestId("fill-handle")).toBeNull();
    cleanup();
    const editor = setup();
    click(editor.view, 1, 1);
    expect(screen.getByTestId("fill-handle")).toBeInTheDocument();
    press(editor.view, "F2");
    expect(screen.queryByTestId("fill-handle")).toBeNull();
  });

  it("drags with pointer events: previews, fills on release, one local transaction", () => {
    const { view, doc, sheetId, transactions } = setup();
    act(() => edit(doc, sheetId, 0, 0, { v: 2 }));
    click(view, 0, 0);
    const handle = screen.getByTestId("fill-handle");
    const before = transactions();
    pointer(handle, "pointerdown");
    pointer(handle, "pointermove", centre(view, 3, 0));
    const preview = screen.getByTestId("fill-preview");
    const top = view.getCellRect({ row: 0, col: 0 })!;
    const bottom = view.getCellRect({ row: 3, col: 0 })!;
    expect(px(preview)).toEqual({
      left: top.x,
      top: top.y,
      width: top.width,
      height: bottom.y + bottom.height - top.y,
    });
    pointer(handle, "pointerup", centre(view, 3, 0));
    expect(screen.queryByTestId("fill-preview")).toBeNull();
    expect(transactions() - before).toBe(1);
    expect(view.displayedText({ row: 3, col: 0 })).toBe("2");
  });

  it("Escape during a drag cancels it", () => {
    const { view, doc, sheetId, transactions } = setup();
    act(() => edit(doc, sheetId, 0, 0, { v: 2 }));
    click(view, 0, 0);
    const handle = screen.getByTestId("fill-handle");
    pointer(handle, "pointerdown");
    pointer(handle, "pointermove", centre(view, 3, 0));
    expect(screen.getByTestId("fill-preview")).toBeInTheDocument();
    press(view, "Escape");
    expect(screen.queryByTestId("fill-preview")).toBeNull();
    pointer(handle, "pointerup", centre(view, 3, 0));
    expect(transactions()).toBe(0);
    expect(view.displayedText({ row: 3, col: 0 })).toBe("");
  });
});
