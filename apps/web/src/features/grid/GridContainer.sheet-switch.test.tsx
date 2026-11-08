import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { addSheet, getCell, readColOrder, readRowOrder } from "@worksheet-clone/shared";
import { createFormulaEngine } from "../../engine";
import { renderWithWorkbook } from "../../test-utils/render-workbook";
import { newDoc } from "../../test-utils/workbook";
import { FakeGridView } from "./adapters/fake/fake-grid-view";
import { GridContainer } from "./GridContainer";

afterEach(cleanup);

describe("GridContainer when the sheet changes", () => {
  it("cancels an open edit without committing it and resets the selection", () => {
    const { doc, sheetId: first } = newDoc();
    let second = "";
    doc.transact(() => {
      second = addSheet(doc, "Sheet2");
    });
    const engine = createFormulaEngine(doc);
    const views: FakeGridView[] = [];
    const createView = () => {
      const view = new FakeGridView();
      views.push(view);
      return view;
    };
    function Harness() {
      const [sheetId, setSheetId] = useState(first);
      return (
        <>
          <button onClick={() => setSheetId(second)}>switch</button>
          <GridContainer key={sheetId} sheetId={sheetId} engine={engine} createView={createView} />
        </>
      );
    }
    const { store } = renderWithWorkbook(<Harness />, { doc });

    const view = views.at(-1)!;
    act(() => {
      view.pointerDown({ row: 2, col: 1 });
      view.pointerUp({ row: 2, col: 1 });
    });
    act(() => view.keyDown({ key: "x" }));
    expect(store.getState().grid.sheetId).toBe(first);
    expect(store.getState().grid.selection).not.toBeNull();
    expect(store.getState().grid.editing).not.toBeNull();

    fireEvent.click(screen.getByText("switch"));

    const grid = store.getState().grid;
    expect(grid.sheetId).toBe(second);
    expect(grid.selection).toBeNull();
    expect(grid.editing).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    // The abandoned draft was never written to the first sheet.
    const rowId = readRowOrder(doc, first)[2]!;
    const colId = readColOrder(doc, first)[1]!;
    expect(getCell(doc, first, rowId, colId)).toBeUndefined();
    engine.destroy();
  });
});
