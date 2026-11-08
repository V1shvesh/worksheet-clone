import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import { afterEach, describe, expect, it } from "vitest";
import type * as Y from "yjs";
import { getRowHeightsMap, readRowOrder } from "@worksheet-clone/shared";
import { createStore } from "../../../app/store";
import { LOCAL_ORIGIN } from "../../../crdt/origin";
import { createWorkbookUndo } from "../../../crdt/undo";
import { WorkbookDocContext } from "../../../crdt/WorkbookDoc";
import { createFormulaEngine } from "../../../engine";
import { newDoc } from "../../../test-utils/workbook";
import { FakeGridView } from "../adapters/fake/fake-grid-view";
import { GridContainer } from "../GridContainer";

afterEach(cleanup);

// jsdom has no PointerEvent, and Testing Library would fall back to a plain Event that drops
// clientX/clientY. A MouseEvent subclass carries the coordinates and the pointer id.
if (!("PointerEvent" in window)) {
  class PolyfilledPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  }
  Object.defineProperty(window, "PointerEvent", { value: PolyfilledPointerEvent });
}

function setup(opts: { readOnly?: boolean } = {}) {
  const { doc, sheetId } = newDoc();
  const view = new FakeGridView();
  const engine = createFormulaEngine(doc);
  const origins: unknown[] = [];
  doc.on("afterTransaction", (tr: Y.Transaction) => {
    if (tr.changed.size > 0) origins.push(tr.origin);
  });
  render(
    <Provider store={createStore()}>
      <WorkbookDocContext.Provider value={{ doc, readOnly: opts.readOnly ?? false }}>
        <GridContainer sheetId={sheetId} engine={engine} createView={() => view} />
      </WorkbookDocContext.Provider>
    </Provider>,
  );
  // Pointer positions of a row header (fake client coordinates are viewport-relative).
  const header = (row: number) => view.getRowHeaderRect(row)!;
  const hover = (row: number) => {
    const r = header(row);
    act(() => {
      fireEvent.pointerMove(document, { clientX: r.x + 10, clientY: r.y + r.height / 2 });
    });
  };
  const height = (row: number) =>
    getRowHeightsMap(doc, sheetId).get(readRowOrder(doc, sheetId)[row]!);
  return { doc, sheetId, view, origins, header, hover, height };
}

const top = (el: HTMLElement) => parseFloat(el.style.top);

describe("row resize handle", () => {
  it("appears only on the hovered row header, on its bottom edge, and follows the hover", () => {
    const t = setup();
    expect(screen.queryByTestId("row-resize-handle")).toBeNull();
    t.hover(2);
    const handle = screen.getByTestId("row-resize-handle");
    const r = t.header(2);
    expect(parseFloat(handle.style.left)).toBe(r.x);
    expect(parseFloat(handle.style.width)).toBe(r.width);
    expect(parseFloat(handle.style.height)).toBe(5);
    // The 5px strip is centred on the row's bottom edge.
    expect(top(handle)).toBeLessThanOrEqual(r.y + r.height);
    expect(top(handle) + 5).toBeGreaterThan(r.y + r.height);
    t.hover(4);
    expect(top(screen.getByTestId("row-resize-handle"))).toBeGreaterThan(top(handle));
    expect(screen.getAllByTestId("row-resize-handle")).toHaveLength(1);
    // Moving into the cells hides it.
    act(() => {
      fireEvent.pointerMove(document, { clientX: 200, clientY: 100 });
    });
    expect(screen.queryByTestId("row-resize-handle")).toBeNull();
  });

  it("dragging shows a guide at the new edge and releasing writes one transaction", () => {
    const t = setup();
    t.hover(1);
    const handle = screen.getByTestId("row-resize-handle");
    const r = t.header(1);
    const startY = r.y + r.height;
    fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: startY, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 10, clientY: startY + 30, pointerId: 1 });
    expect(top(screen.getByTestId("row-resize-guide"))).toBe(startY + 30);
    expect(t.origins).toEqual([]); // nothing written while dragging
    fireEvent.pointerMove(handle, { clientX: 10, clientY: startY + 40, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 10, clientY: startY + 40, pointerId: 1 });
    expect(t.height(1)).toBe(r.height + 40);
    expect(t.origins).toEqual([LOCAL_ORIGIN]);
    expect(screen.queryByTestId("row-resize-guide")).toBeNull();
    expect(t.view.getCellRect({ row: 1, col: 0 })!.height).toBe(r.height + 40);
  });

  it("the guide and the result are clamped to the minimum height", () => {
    const t = setup();
    t.hover(0);
    const handle = screen.getByTestId("row-resize-handle");
    const r = t.header(0);
    const startY = r.y + r.height;
    fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: startY, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 10, clientY: startY - 200, pointerId: 1 });
    expect(top(screen.getByTestId("row-resize-guide"))).toBe(r.y + 16);
    fireEvent.pointerUp(handle, { clientX: 10, clientY: startY - 200, pointerId: 1 });
    expect(t.height(0)).toBe(16);
  });

  it("a cancelled drag writes nothing, and a release without movement writes nothing", () => {
    const t = setup();
    t.hover(1);
    const handle = screen.getByTestId("row-resize-handle");
    const y = t.header(1).y + t.header(1).height;
    fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: y, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 10, clientY: y + 20, pointerId: 1 });
    fireEvent.pointerCancel(handle, { pointerId: 1 });
    expect(t.origins).toEqual([]);
    fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: y, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 10, clientY: y, pointerId: 1 });
    expect(t.height(1)).toBe(t.header(1).height);
  });

  it("is one undo step", () => {
    const t = setup();
    const history = createWorkbookUndo(t.doc, {
      isReadOnly: () => false,
      getContext: () => ({ sheetId: t.sheetId, selection: null }),
    });
    t.hover(3);
    const handle = screen.getByTestId("row-resize-handle");
    const y = t.header(3).y + t.header(3).height;
    fireEvent.pointerDown(handle, { button: 0, clientX: 10, clientY: y, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 10, clientY: y + 25, pointerId: 1 });
    expect(t.height(3)).toBe(49);
    act(() => {
      history.undo();
    });
    expect(t.height(3)).toBeUndefined();
    expect(t.view.getCellRect({ row: 3, col: 0 })!.height).toBe(24);
    history.destroy();
  });

  it("is never shown to a viewer", () => {
    const t = setup({ readOnly: true });
    t.hover(2);
    expect(screen.queryByTestId("row-resize-handle")).toBeNull();
    expect(t.origins).toEqual([]);
  });
});
