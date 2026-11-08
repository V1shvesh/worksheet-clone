import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { createStore } from "../../../app/store";
import { colorForUser, createPresencePublisher } from "../../../crdt/presence";
import { deleteRows } from "../../../crdt/mutations";
import { WorkbookDocContext } from "../../../crdt/WorkbookDoc";
import { createFormulaEngine } from "../../../engine";
import { newDoc } from "../../../test-utils/workbook";
import { FakeGridView } from "../adapters/fake/fake-grid-view";
import { GridContainer } from "../GridContainer";
import { SheetViewModel } from "../model";

afterEach(cleanup);

const BOB = { id: "u-bob", email: "bob@example.com" };
const rectOf = (el: HTMLElement) => ({
  left: parseFloat(el.style.left),
  top: parseFloat(el.style.top),
  width: parseFloat(el.style.width),
  height: parseFloat(el.style.height),
});

function setup() {
  const { doc, sheetId } = newDoc();
  const store = createStore();
  const view = new FakeGridView();
  const engine = createFormulaEngine(doc);
  const awareness = new Awareness(doc);
  render(
    <Provider store={store}>
      <WorkbookDocContext.Provider value={{ doc, awareness, readOnly: false }}>
        <GridContainer sheetId={sheetId} engine={engine} createView={() => view} />
      </WorkbookDocContext.Provider>
    </Provider>,
  );
  const model = new SheetViewModel(doc, sheetId, engine);

  const remote = new Awareness(new Y.Doc());
  remote.on("update", ({ added, updated, removed }: Record<string, number[]>) =>
    applyAwarenessUpdate(
      awareness,
      encodeAwarenessUpdate(remote, [...added!, ...updated!, ...removed!]),
      "remote",
    ),
  );
  const publisher = createPresencePublisher(remote, BOB);
  // Past the throttle window the next update publishes at once.
  const publishAt = (
    onSheet: string | null,
    anchor: [number, number] | null,
    focus: [number, number] = anchor!,
  ) =>
    act(() => {
      publisher.update(
        onSheet,
        anchor && {
          anchor: { rowId: model.rowIdAt(anchor[0])!, colId: model.colIdAt(anchor[1])! },
          focus: { rowId: model.rowIdAt(focus[0])!, colId: model.colIdAt(focus[1])! },
        },
      );
      return new Promise<void>((resolve) => setTimeout(resolve, 120));
    });
  return { doc, sheetId, view, model, remote, publishAt };
}

describe("remote cursors", () => {
  it("outlines the peer's active cell at getCellRect with the peer's color and name tag", async () => {
    const { view, sheetId, publishAt } = setup();
    await publishAt(sheetId, [2, 1]);
    const cursor = screen.getByTestId("remote-cursor");
    const rect = view.getCellRect({ row: 2, col: 1 })!;
    expect(rectOf(cursor)).toEqual({
      left: rect.x,
      top: rect.y,
      width: rect.width,
      height: rect.height,
    });
    expect(cursor).toHaveAttribute("data-user-id", BOB.id);
    expect(cursor).toHaveStyle({ borderColor: colorForUser(BOB.id) });
    expect(cursor).toHaveTextContent("bob");
    expect(cursor.style.pointerEvents).not.toBe("auto");
  });

  it("tints the peer's range (clipped to what is visible) and follows scroll", async () => {
    const { view, sheetId, publishAt } = setup();
    await publishAt(sheetId, [2, 1], [4, 3]);
    const a = view.getCellRect({ row: 2, col: 1 })!;
    const b = view.getCellRect({ row: 4, col: 3 })!;
    const tint = screen.getByTestId("remote-selection");
    expect(rectOf(tint)).toEqual({
      left: a.x,
      top: a.y,
      width: b.x + b.width - a.x,
      height: b.y + b.height - a.y,
    });
    act(() => view.scrollTo(0, 24));
    expect(rectOf(screen.getByTestId("remote-selection")).top).toBe(a.y - 24);
    expect(rectOf(screen.getByTestId("remote-cursor")).top).toBe(a.y - 24);

    act(() => view.scrollTo(0, 24 * 60));
    expect(screen.queryByTestId("remote-selection")).toBeNull();
    expect(screen.queryByTestId("remote-cursor")).toBeNull();
  });

  it("shows nothing for a peer on another sheet, and again once they come to this one", async () => {
    const { sheetId, publishAt } = setup();
    await publishAt("some-other-sheet", [1, 1]);
    expect(screen.queryByTestId("remote-cursor")).toBeNull();
    await publishAt(sheetId, [1, 1]);
    expect(screen.getByTestId("remote-cursor")).toBeInTheDocument();
    await publishAt(sheetId, null);
    expect(screen.queryByTestId("remote-cursor")).toBeNull();
  });

  it("hides the cursor when the peer's row was deleted, and moves it when rows shift", async () => {
    const { doc, sheetId, view, publishAt } = setup();
    await publishAt(sheetId, [3, 0]);
    const model = new SheetViewModel(doc, sheetId, createFormulaEngine(doc));
    const rowId = model.rowIdAt(3)!;

    act(() => {
      deleteRows(doc, false, sheetId, [model.rowIdAt(0)!]);
    });
    expect(rectOf(screen.getByTestId("remote-cursor")).top).toBe(
      view.getCellRect({ row: 2, col: 0 })!.y,
    );

    act(() => {
      deleteRows(doc, false, sheetId, [rowId]);
    });
    expect(screen.queryByTestId("remote-cursor")).toBeNull();
  });

  it("draws remote cursors below our own selection", async () => {
    const { view, sheetId, publishAt } = setup();
    await publishAt(sheetId, [1, 1]);
    act(() => {
      view.pointerDown({ row: 1, col: 1 });
      view.pointerUp({ row: 1, col: 1 });
    });
    const overlay = screen.getByTestId("active-cell").parentElement!;
    const children = [...overlay.children];
    expect(children.indexOf(screen.getByTestId("remote-cursor"))).toBeLessThan(
      children.indexOf(screen.getByTestId("active-cell")),
    );
  });
});
