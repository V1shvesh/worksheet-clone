import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The only e2e code that knows the grid's DOM. Rows and columns are 0-based visual indices
 * (A1 is row 0, col 0). Selectors rely on our own role/data-* attributes and test ids, never
 * on grid-library classes.
 */
export class GridPage {
  constructor(readonly page: Page) {}

  cell(row: number, col: number): Locator {
    return this.page.locator(`[role="gridcell"][data-row="${row}"][data-col="${col}"]`);
  }

  columnHeader(col: number): Locator {
    return this.page.locator(`[data-col-header="${col}"]`);
  }

  rowHeader(row: number): Locator {
    return this.page.locator(`[role="rowheader"][data-row-header="${row}"]`);
  }

  editor(): Locator {
    return this.page.getByTestId("cell-editor");
  }

  selectionRect(): Locator {
    return this.page.getByTestId("selection-rect");
  }

  activeCell(): Locator {
    return this.page.getByTestId("active-cell");
  }

  /** A collaborator's outline on their active cell (one per tab they have open on this sheet). */
  remoteCursor(userId?: string): Locator {
    const all = this.page.getByTestId("remote-cursor");
    return userId ? all.and(this.page.locator(`[data-user-id="${userId}"]`)) : all;
  }

  remoteSelection(userId?: string): Locator {
    const all = this.page.getByTestId("remote-selection");
    return userId ? all.and(this.page.locator(`[data-user-id="${userId}"]`)) : all;
  }

  /** Who else is here, as avatars in the header. */
  avatars(): Locator {
    return this.page.getByTestId("presence-avatar");
  }

  formulaBar(): Locator {
    return this.page.getByLabel("Formula bar", { exact: true });
  }

  nameBox(): Locator {
    return this.page.getByTestId("name-box");
  }

  toolbarButton(name: "Undo" | "Redo" | "Bold" | "Italic" | "Underline" | "Fill color"): Locator {
    return this.page.getByTestId("toolbar").getByRole("button", { name, exact: true });
  }

  fillHandle(): Locator {
    return this.page.getByTestId("fill-handle");
  }

  fillPreview(): Locator {
    return this.page.getByTestId("fill-preview");
  }

  cutRect(): Locator {
    return this.page.getByTestId("cut-rect");
  }

  toasts(): Locator {
    return this.page.getByTestId("toast");
  }

  /** Picks a swatch (by its name, e.g. "Yellow") from the toolbar's fill-color popover. */
  async pickFillColor(name: string): Promise<void> {
    await this.toolbarButton("Fill color").click();
    await this.page
      .getByRole("group", { name: "Fill colors" })
      .getByRole("button", { name, exact: true })
      .click();
  }

  /** Real mouse drag of the fill handle to the centre of the given cell. */
  async dragFillHandle(row: number, col: number): Promise<void> {
    const handle = await this.fillHandle().boundingBox();
    if (!handle) throw new Error("fill handle is not rendered");
    const to = await this.center(row, col);
    await this.page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await this.page.mouse.down();
    await this.page.mouse.move(to.x, to.y, { steps: 10 });
    await this.page.mouse.up();
  }

  /** Real chord, e.g. "ControlOrMeta+c". */
  async chord(keys: string): Promise<void> {
    await this.page.keyboard.press(keys);
  }

  /** Puts text on the (browser) clipboard, as another app would. Needs clipboard permissions. */
  async writeClipboard(text: string): Promise<void> {
    await this.page.evaluate((t) => navigator.clipboard.writeText(t), text);
  }

  /** The clipboard's text/plain and text/html flavors. */
  async readClipboard(): Promise<{ text: string; html: string }> {
    return this.page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const read = async (type: string) =>
        item && item.types.includes(type) ? await (await item.getType(type)).text() : "";
      return { text: await read("text/plain"), html: await read("text/html") };
    });
  }

  async clickCell(row: number, col: number): Promise<void> {
    await this.cell(row, col).click();
  }

  async shiftClickCell(row: number, col: number): Promise<void> {
    await this.cell(row, col).click({ modifiers: ["Shift"] });
  }

  /** Real mouse down, move and up from the centre of one cell to the centre of another. */
  async dragSelect(from: [number, number], to: [number, number]): Promise<void> {
    const a = await this.center(...from);
    const b = await this.center(...to);
    await this.page.mouse.move(a.x, a.y);
    await this.page.mouse.down();
    await this.page.mouse.move(b.x, b.y, { steps: 8 });
    await this.page.mouse.up();
  }

  /** Selects the cell, types the text and commits with Enter. */
  async typeInto(row: number, col: number, text: string): Promise<void> {
    await this.clickCell(row, col);
    await this.page.keyboard.type(text);
    await this.page.keyboard.press("Enter");
  }

  // --- structure: context menu, header selection, resizing -----------------------------

  contextMenu(): Locator {
    return this.page.getByTestId("grid-context-menu");
  }

  /** A menu item by its id: `insert-rows-above`, `delete-rows`, `delete-cols`, `clear`, ... */
  menuItem(id: string): Locator {
    return this.page.getByTestId(`menu-${id}`);
  }

  async rightClickCell(row: number, col: number): Promise<void> {
    await this.cell(row, col).click({ button: "right" });
    await expect(this.contextMenu()).toBeVisible();
  }

  async rightClickRowHeader(row: number): Promise<void> {
    await this.rowHeader(row).click({ button: "right" });
    await expect(this.contextMenu()).toBeVisible();
  }

  async rightClickColumnHeader(col: number): Promise<void> {
    await this.columnHeader(col).click({ button: "right" });
    await expect(this.contextMenu()).toBeVisible();
  }

  /** Clicks a menu item and waits for the menu to close. */
  async chooseMenuItem(id: string): Promise<void> {
    await this.menuItem(id).click();
    await expect(this.contextMenu()).toHaveCount(0);
  }

  /** Selects whole rows: click the first row header, Shift+click the last. */
  async selectRows(from: number, to = from): Promise<void> {
    await this.rowHeader(from).click();
    if (to !== from) await this.rowHeader(to).click({ modifiers: ["Shift"] });
  }

  /** Selects whole columns: click the first column header, Shift+click the last. */
  async selectColumns(from: number, to = from): Promise<void> {
    await this.columnHeader(from).click();
    if (to !== from) await this.columnHeader(to).click({ modifiers: ["Shift"] });
  }

  /** The text of a row header, i.e. the row number the user sees. */
  async rowHeaderLabel(row: number): Promise<string> {
    return ((await this.rowHeader(row).textContent()) ?? "").trim();
  }

  rowResizeHandle(): Locator {
    return this.page.getByTestId("row-resize-handle");
  }

  /**
   * The row header's height in px (the row's height, give or take a border pixel). 0 while the
   * header is momentarily not rendered (the grid re-renders after a resize), so it can be used
   * inside `expect.poll`, which does not retry a throwing callback.
   */
  async rowHeight(row: number): Promise<number> {
    const box = await this.rowHeader(row)
      .boundingBox({ timeout: 1000 })
      .catch(() => null);
    return box ? Math.round(box.height) : 0;
  }

  /** The column header's width in px; 0 while it is not rendered (see `rowHeight`). */
  async columnWidth(col: number): Promise<number> {
    const box = await this.columnHeader(col)
      .boundingBox({ timeout: 1000 })
      .catch(() => null);
    return box ? Math.round(box.width) : 0;
  }

  /** Real mouse drag of a row's bottom-edge handle (shown on hover) by `deltaY` pixels. */
  async dragRowResize(row: number, deltaY: number): Promise<void> {
    const header = await this.rowHeader(row).boundingBox();
    if (!header) throw new Error(`row header ${row} is not rendered`);
    await this.page.mouse.move(header.x + header.width / 2, header.y + header.height / 2);
    const handle = await this.rowResizeHandle().boundingBox();
    if (!handle) throw new Error("row resize handle is not rendered");
    const x = handle.x + handle.width / 2;
    const y = handle.y + handle.height / 2;
    await this.page.mouse.move(x, y);
    await this.page.mouse.down();
    await this.page.mouse.move(x, y + deltaY, { steps: 8 });
    await this.page.mouse.up();
  }

  /** Real mouse drag of a column header's right edge by `deltaX` pixels. */
  async dragColumnResize(col: number, deltaX: number): Promise<void> {
    const header = await this.columnHeader(col).boundingBox();
    if (!header) throw new Error(`column header ${col} is not rendered`);
    const x = header.x + header.width - 2;
    const y = header.y + header.height / 2;
    await this.page.mouse.move(x, y);
    await this.page.mouse.down();
    await this.page.mouse.move(x + deltaX, y, { steps: 8 });
    await this.page.mouse.up();
  }

  async cellText(row: number, col: number): Promise<string> {
    return (await this.cell(row, col).textContent()) ?? "";
  }

  /** Wheel-scrolls the grid body by the given pixel deltas. */
  async wheel(deltaX: number, deltaY: number): Promise<void> {
    const area = await this.overlayBox();
    await this.page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
    await this.page.mouse.wheel(deltaX, deltaY);
  }

  /** Bounding box of the overlay layer, which exactly covers the grid's mount element. */
  async overlayBox(): Promise<Box> {
    // Our own overlay class (not a grid-library one); it has no test id.
    const box = await this.page.locator(".grid-overlay").boundingBox();
    if (!box) throw new Error("grid overlay is not rendered");
    return box;
  }

  /** The active-cell outline sits exactly on the given cell (retries while the UI settles). */
  async expectActiveOn(row: number, col: number, tolerance = 2): Promise<void> {
    await expect(this.activeCell()).toBeVisible();
    await expect
      .poll(async () =>
        boxDistance(await this.activeCell().boundingBox(), await this.cellBox(row, col)),
      )
      .toBeLessThanOrEqual(tolerance);
  }

  /** The selection rectangle covers exactly the cells between the two corners (inclusive). */
  async expectSelectionOver(
    from: [number, number],
    to: [number, number],
    tolerance = 2,
  ): Promise<void> {
    await expect(this.selectionRect()).toBeVisible();
    await expect
      .poll(async () => {
        const a = await this.cellBox(...from);
        const b = await this.cellBox(...to);
        if (!a || !b) return Infinity;
        const x = Math.min(a.x, b.x);
        const y = Math.min(a.y, b.y);
        const union: Box = {
          x,
          y,
          width: Math.max(a.x + a.width, b.x + b.width) - x,
          height: Math.max(a.y + a.height, b.y + b.height) - y,
        };
        return boxDistance(await this.selectionRect().boundingBox(), union);
      })
      .toBeLessThanOrEqual(tolerance);
  }

  async cellBox(row: number, col: number): Promise<Box | null> {
    // `boundingBox()` waits for the element to exist; virtualized-away cells must give null.
    const cell = this.cell(row, col);
    if ((await cell.count()) === 0) return null;
    return cell.boundingBox({ timeout: 1000 }).catch(() => null);
  }

  private async center(row: number, col: number): Promise<{ x: number; y: number }> {
    const box = await this.cell(row, col).boundingBox();
    if (!box) throw new Error(`cell ${row},${col} is not rendered`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Largest edge-to-edge difference in px between two boxes; Infinity when either is missing. */
function boxDistance(a: Box | null, b: Box | null): number {
  if (!a || !b) return Infinity;
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - (b.x + b.width)),
    Math.abs(a.y + a.height - (b.y + b.height)),
  );
}
