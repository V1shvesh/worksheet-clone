import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  addSheet,
  getSheetName,
  isSheetHidden,
  readSheetOrder,
  setSheetHidden,
  setSheetName,
} from "@worksheet-clone/shared";
import { asRemote, renderWithWorkbook } from "../../test-utils/render-workbook";
import { newDoc } from "../../test-utils/workbook";
import { SheetTabs } from "./SheetTabs";

// jsdom has no PointerEvent, and fireEvent would drop clientX without one.
beforeAll(() => {
  if (typeof window.PointerEvent === "undefined") {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    }
    // @ts-expect-error test-only polyfill
    window.PointerEvent = PointerEventPolyfill;
  }
});
afterEach(cleanup);

function setup(opts: { readOnly?: boolean; names?: string[]; active?: number } = {}) {
  const { doc, sheetId: first } = newDoc();
  const ids = [first];
  doc.transact(() => {
    for (const name of opts.names ?? ["Sheet2", "Sheet3"]) ids.push(addSheet(doc, name));
  });
  const route = `/workbooks/w1?sheet=${ids[opts.active ?? 0]}`;
  const utils = renderWithWorkbook(<SheetTabs />, { doc, readOnly: opts.readOnly, route });
  return { doc, ids, ...utils };
}

const tabs = () => screen.getAllByTestId("sheet-tab");
const tabNames = () => tabs().map((t) => t.textContent);
const location = () => screen.getByTestId("location").textContent;
const tabOf = (id: string) => tabs().find((t) => t.getAttribute("data-sheet-id") === id)!;

/** Gives each tab a 100px-wide box so drag math has geometry. */
function layoutTabs() {
  tabs().forEach((tab, i) => {
    tab.getBoundingClientRect = () =>
      ({
        left: i * 100,
        right: i * 100 + 100,
        width: 100,
        top: 0,
        bottom: 30,
        height: 30,
      }) as DOMRect;
  });
}

describe("SheetTabs", () => {
  it("renders an accessible tablist and marks the active tab", () => {
    const { ids } = setup({ active: 1 });
    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(tabNames()).toEqual(["Sheet1", "Sheet2", "Sheet3"]);
    expect(tabOf(ids[1]!)).toHaveAttribute("aria-selected", "true");
    expect(tabOf(ids[0]!)).toHaveAttribute("aria-selected", "false");
  });

  it("switches on click and replaces history", () => {
    const { ids } = setup();
    fireEvent.click(tabOf(ids[2]!));
    expect(location()).toBe(`/workbooks/w1?sheet=${ids[2]}`);
    expect(screen.getByTestId("nav-type")).toHaveTextContent("REPLACE");
    expect(tabOf(ids[2]!)).toHaveAttribute("aria-selected", "true");
  });

  it("adds a sheet after the current tab and opens it", () => {
    const { doc, ids } = setup();
    fireEvent.click(screen.getByTestId("add-sheet"));
    const order = readSheetOrder(doc);
    expect(order).toHaveLength(4);
    expect(order[0]).toBe(ids[0]);
    expect(order[2]).toBe(ids[1]);
    const added = order[1]!;
    expect(getSheetName(doc, added)).toBe("Sheet4");
    expect(location()).toBe(`/workbooks/w1?sheet=${added}`);
  });

  describe("rename", () => {
    function startRename(id: string) {
      fireEvent.doubleClick(tabOf(id));
      return screen.getByLabelText("Sheet name") as HTMLInputElement;
    }

    it("commits on Enter", () => {
      const { doc, ids } = setup();
      const input = startRename(ids[0]!);
      fireEvent.change(input, { target: { value: "Budget" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(getSheetName(doc, ids[0]!)).toBe("Budget");
      expect(screen.queryByLabelText("Sheet name")).toBeNull();
    });

    it("cancels on Escape", () => {
      const { doc, ids } = setup();
      const input = startRename(ids[0]!);
      fireEvent.change(input, { target: { value: "Budget" } });
      fireEvent.keyDown(input, { key: "Escape" });
      expect(getSheetName(doc, ids[0]!)).toBe("Sheet1");
      expect(screen.queryByLabelText("Sheet name")).toBeNull();
    });

    it("commits on blur", () => {
      const { doc, ids } = setup();
      const input = startRename(ids[0]!);
      fireEvent.change(input, { target: { value: "Budget" } });
      fireEvent.blur(input);
      expect(getSheetName(doc, ids[0]!)).toBe("Budget");
    });

    it("shows a duplicate-name error and keeps the input open on Enter", () => {
      const { doc, ids } = setup();
      const input = startRename(ids[0]!);
      fireEvent.change(input, { target: { value: "sheet2" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByRole("alert")).toHaveTextContent('A sheet named "sheet2" already exists');
      expect(screen.getByLabelText("Sheet name")).toBeInTheDocument();
      expect(getSheetName(doc, ids[0]!)).toBe("Sheet1");
      // Typing clears the error.
      fireEvent.change(input, { target: { value: "ok" } });
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("cancels on blur with an invalid name", () => {
      const { doc, ids } = setup();
      const input = startRename(ids[0]!);
      fireEvent.change(input, { target: { value: "a:b" } });
      fireEvent.blur(input);
      expect(getSheetName(doc, ids[0]!)).toBe("Sheet1");
      expect(screen.queryByLabelText("Sheet name")).toBeNull();
    });

    it("keeps the draft when a collaborator renames the same sheet", () => {
      const { doc, ids } = setup();
      const input = startRename(ids[1]!);
      fireEvent.change(input, { target: { value: "My draft" } });
      act(() => asRemote(doc, () => setSheetName(doc, ids[1]!, "Remote")));
      expect(screen.getByLabelText("Sheet name")).toHaveValue("My draft");
      fireEvent.keyDown(input, { key: "Escape" });
      expect(tabNames()[1]).toBe("Remote");
    });

    it("shows a remote rename live on other tabs", () => {
      const { doc, ids } = setup();
      act(() => asRemote(doc, () => setSheetName(doc, ids[2]!, "Renamed")));
      expect(tabNames()).toEqual(["Sheet1", "Sheet2", "Renamed"]);
    });
  });

  describe("menu", () => {
    const item = (id: string) => screen.getByTestId(`sheet-menu-${id}`);

    it("opens from the button on the active tab and closes on Escape and outside press", () => {
      setup();
      fireEvent.click(screen.getByTestId("sheet-tab-menu"));
      expect(screen.getByRole("menu")).toBeInTheDocument();
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();

      fireEvent.click(screen.getByTestId("sheet-tab-menu"));
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("opens on right-click of any tab and switches to it", () => {
      const { ids } = setup();
      fireEvent.contextMenu(tabOf(ids[2]!));
      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(location()).toBe(`/workbooks/w1?sheet=${ids[2]}`);
    });

    it("rename starts inline editing", () => {
      setup();
      fireEvent.click(screen.getByTestId("sheet-tab-menu"));
      fireEvent.click(item("rename"));
      expect(screen.getByLabelText("Sheet name")).toBeInTheDocument();
    });

    it("hides a sheet, moves to a neighbour and lists it under hidden sheets", () => {
      const { doc, ids } = setup({ active: 1 });
      fireEvent.click(screen.getByTestId("sheet-tab-menu"));
      fireEvent.click(item("hide"));
      expect(isSheetHidden(doc, ids[1]!)).toBe(true);
      expect(tabNames()).toEqual(["Sheet1", "Sheet3"]);
      expect(location()).toBe(`/workbooks/w1?sheet=${ids[2]}`);

      fireEvent.click(screen.getByTestId("hidden-sheets"));
      const menu = screen.getByTestId("hidden-sheets-menu");
      fireEvent.click(within(menu).getByText("Sheet2"));
      expect(isSheetHidden(doc, ids[1]!)).toBe(false);
      expect(tabNames()).toEqual(["Sheet1", "Sheet2", "Sheet3"]);
      expect(location()).toBe(`/workbooks/w1?sheet=${ids[1]}`);
      expect(screen.queryByTestId("hidden-sheets")).toBeNull();
    });

    it("moves left and right, skipping hidden sheets", () => {
      const { doc, ids } = setup({ active: 2 });
      act(() => asRemote(doc, () => setSheetHidden(doc, ids[1]!, true)));
      expect(tabNames()).toEqual(["Sheet1", "Sheet3"]);
      fireEvent.click(screen.getByTestId("sheet-tab-menu"));
      fireEvent.click(item("move-left"));
      expect(tabNames()).toEqual(["Sheet3", "Sheet1"]);
      expect(readSheetOrder(doc)).toEqual([ids[2], ids[0], ids[1]]);

      fireEvent.click(screen.getByTestId("sheet-tab-menu"));
      expect(item("move-left")).toBeDisabled();
      fireEvent.click(item("move-right"));
      expect(tabNames()).toEqual(["Sheet1", "Sheet3"]);
    });

    it("disables move at the ends", () => {
      setup({ active: 0 });
      fireEvent.click(screen.getByTestId("sheet-tab-menu"));
      expect(item("move-left")).toBeDisabled();
      expect(item("move-right")).toBeEnabled();
    });

    it("disables hide and delete for the last visible sheet", () => {
      setup({ names: [] });
      fireEvent.click(screen.getByTestId("sheet-tab-menu"));
      expect(item("hide")).toBeDisabled();
      expect(item("delete")).toBeDisabled();
    });

    it("confirms before deleting and warns about #REF!", () => {
      const { doc, ids } = setup({ active: 1 });
      fireEvent.click(screen.getByTestId("sheet-tab-menu"));
      fireEvent.click(item("delete"));
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveTextContent("#REF!");
      expect(readSheetOrder(doc)).toHaveLength(3);

      fireEvent.click(within(dialog).getByText("Cancel"));
      expect(readSheetOrder(doc)).toHaveLength(3);

      fireEvent.click(screen.getByTestId("sheet-tab-menu"));
      fireEvent.click(item("delete"));
      fireEvent.click(screen.getByText("Delete sheet", { selector: "button" }));
      expect(readSheetOrder(doc)).toEqual([ids[0], ids[2]]);
      expect(location()).toBe(`/workbooks/w1?sheet=${ids[2]}`);
    });

    it("closes a pending delete when a collaborator deletes the sheet first", () => {
      const { doc, ids } = setup({ active: 1 });
      fireEvent.click(screen.getByTestId("sheet-tab-menu"));
      fireEvent.click(item("delete"));
      act(() =>
        asRemote(doc, () => {
          doc.getMap("sheets").delete(ids[1]!);
          const order = doc.getArray<string>("sheetOrder");
          order.delete(order.toArray().indexOf(ids[1]!), 1);
        }),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  describe("drag to reorder", () => {
    it("does not start a drag below the 5px threshold, so a click still switches", () => {
      const { doc, ids } = setup();
      layoutTabs();
      const tab = tabOf(ids[1]!);
      fireEvent.pointerDown(tab, { clientX: 150, button: 0, pointerId: 1 });
      fireEvent.pointerMove(tab, { clientX: 153, pointerId: 1 });
      fireEvent.pointerUp(tab, { clientX: 153, pointerId: 1 });
      fireEvent.click(tab);
      expect(readSheetOrder(doc)).toEqual(ids);
      expect(location()).toBe(`/workbooks/w1?sheet=${ids[1]}`);
    });

    it("drops a tab at the pointer, showing a marker, and ignores the trailing click", () => {
      const { doc, ids } = setup();
      layoutTabs();
      const tab = tabOf(ids[0]!);
      fireEvent.pointerDown(tab, { clientX: 50, button: 0, pointerId: 1 });
      fireEvent.pointerMove(tab, { clientX: 280, pointerId: 1 });
      expect(tabOf(ids[2]!)).toHaveClass("sheet-tab--drop-after");
      fireEvent.pointerUp(tab, { clientX: 280, pointerId: 1 });
      fireEvent.click(tab);
      expect(readSheetOrder(doc)).toEqual([ids[1], ids[2], ids[0]]);
      expect(location()).toBe(`/workbooks/w1?sheet=${ids[0]}`);
      expect(document.querySelector(".sheet-tab--drop-after")).toBeNull();
    });

    it("moves a tab to the front", () => {
      const { doc, ids } = setup({ active: 2 });
      layoutTabs();
      const tab = tabOf(ids[2]!);
      fireEvent.pointerDown(tab, { clientX: 250, button: 0, pointerId: 1 });
      fireEvent.pointerMove(tab, { clientX: 10, pointerId: 1 });
      expect(tabOf(ids[0]!)).toHaveClass("sheet-tab--drop-before");
      fireEvent.pointerUp(tab, { clientX: 10, pointerId: 1 });
      expect(readSheetOrder(doc)).toEqual([ids[2], ids[0], ids[1]]);
    });

    it("writes nothing when dropped on its own slot", () => {
      const { doc, ids } = setup();
      layoutTabs();
      let updates = 0;
      doc.on("update", () => updates++);
      const tab = tabOf(ids[1]!);
      fireEvent.pointerDown(tab, { clientX: 150, button: 0, pointerId: 1 });
      fireEvent.pointerMove(tab, { clientX: 170, pointerId: 1 });
      fireEvent.pointerUp(tab, { clientX: 170, pointerId: 1 });
      expect(updates).toBe(0);
    });

    it("Escape cancels the drag", () => {
      const { doc, ids } = setup();
      layoutTabs();
      const tab = tabOf(ids[0]!);
      fireEvent.pointerDown(tab, { clientX: 50, button: 0, pointerId: 1 });
      fireEvent.pointerMove(tab, { clientX: 280, pointerId: 1 });
      fireEvent.keyDown(document, { key: "Escape" });
      expect(document.querySelector(".sheet-tab--drop-after")).toBeNull();
      fireEvent.pointerUp(tab, { clientX: 280, pointerId: 1 });
      expect(readSheetOrder(doc)).toEqual(ids);
    });
  });

  describe("viewer", () => {
    it("can switch tabs but has no editing controls", () => {
      const { doc, ids } = setup({ readOnly: true });
      act(() => asRemote(doc, () => setSheetHidden(doc, ids[2]!, true)));
      expect(screen.queryByTestId("add-sheet")).toBeNull();
      expect(screen.queryByTestId("hidden-sheets")).toBeNull();
      expect(screen.queryByTestId("sheet-tab-menu")).toBeNull();

      fireEvent.click(tabOf(ids[1]!));
      expect(location()).toBe(`/workbooks/w1?sheet=${ids[1]}`);

      fireEvent.doubleClick(tabOf(ids[1]!));
      expect(screen.queryByLabelText("Sheet name")).toBeNull();
      fireEvent.contextMenu(tabOf(ids[1]!));
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("cannot drag", () => {
      const { doc, ids } = setup({ readOnly: true });
      layoutTabs();
      const tab = tabOf(ids[0]!);
      fireEvent.pointerDown(tab, { clientX: 50, button: 0, pointerId: 1 });
      fireEvent.pointerMove(tab, { clientX: 280, pointerId: 1 });
      fireEvent.pointerUp(tab, { clientX: 280, pointerId: 1 });
      expect(readSheetOrder(doc)).toEqual(ids);
    });

    it("drops editing affordances when access becomes read-only mid-rename", () => {
      const { ids, setReadOnly } = setup();
      fireEvent.doubleClick(tabOf(ids[0]!));
      expect(screen.getByLabelText("Sheet name")).toBeInTheDocument();
      setReadOnly(true);
      expect(screen.queryByLabelText("Sheet name")).toBeNull();
      expect(screen.queryByTestId("add-sheet")).toBeNull();
    });
  });
});
