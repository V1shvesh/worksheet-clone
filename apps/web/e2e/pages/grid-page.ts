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
