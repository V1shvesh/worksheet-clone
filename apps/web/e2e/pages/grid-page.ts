import type { Locator, Page } from "@playwright/test";

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

  private async center(row: number, col: number): Promise<{ x: number; y: number }> {
    const box = await this.cell(row, col).boundingBox();
    if (!box) throw new Error(`cell ${row},${col} is not rendered`);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
}
