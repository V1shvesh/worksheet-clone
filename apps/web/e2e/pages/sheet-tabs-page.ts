import { expect, type Locator, type Page } from "@playwright/test";

/**
 * The sheet tab bar, found through our own roles, labels and test ids only
 * (never grid-library DOM). Tabs are addressed by their visible name.
 */
export class SheetTabsPage {
  constructor(readonly page: Page) {}

  tablist(): Locator {
    return this.page.getByRole("tablist", { name: "Sheets" });
  }

  tabs(): Locator {
    return this.page.getByTestId("sheet-tab");
  }

  tab(name: string): Locator {
    return this.page.getByRole("tab", { name, exact: true });
  }

  activeTab(): Locator {
    return this.page.locator('[data-testid="sheet-tab"][aria-selected="true"]');
  }

  addButton(): Locator {
    return this.page.getByTestId("add-sheet");
  }

  hiddenButton(): Locator {
    return this.page.getByTestId("hidden-sheets");
  }

  renameInput(): Locator {
    return this.page.getByLabel("Sheet name", { exact: true });
  }

  menuItem(id: "rename" | "hide" | "move-left" | "move-right" | "delete"): Locator {
    return this.page.getByTestId(`sheet-menu-${id}`);
  }

  /** Items of the "Hidden sheets" menu, by sheet name. */
  hiddenItem(name: string): Locator {
    return this.page.getByTestId("hidden-sheets-menu").getByRole("menuitem", { name, exact: true });
  }

  /** Visible tab names, left to right. */
  async names(): Promise<string[]> {
    return (await this.tabs().allTextContents()).map((text) => text.trim());
  }

  async expectNames(names: string[]): Promise<void> {
    await expect(this.tabs()).toHaveText(names);
  }

  async sheetId(name: string): Promise<string> {
    const id = await this.tab(name).getAttribute("data-sheet-id");
    if (!id) throw new Error(`no tab named ${name}`);
    return id;
  }

  /** The `?sheet=` value of the current URL. */
  urlSheetId(): string | null {
    return new URL(this.page.url()).searchParams.get("sheet");
  }

  async add(): Promise<void> {
    await this.addButton().click();
  }

  async open(name: string): Promise<void> {
    await this.tab(name).click();
  }

  async rename(name: string, to: string): Promise<void> {
    await this.tab(name).dblclick();
    await this.renameInput().fill(to);
    await this.renameInput().press("Enter");
  }

  /** Right-click menu on a tab. */
  async openMenu(name: string): Promise<void> {
    await this.tab(name).click({ button: "right" });
  }

  async chooseMenuItem(name: string, id: "rename" | "hide" | "delete"): Promise<void> {
    await this.openMenu(name);
    await this.menuItem(id).click();
  }

  /** Real pointer drag from the centre of one tab onto the right (or left) half of another. */
  async drag(name: string, onto: string, side: "before" | "after"): Promise<void> {
    const from = await this.tab(name).boundingBox();
    const to = await this.tab(onto).boundingBox();
    if (!from || !to) throw new Error("tab is not rendered");
    const targetX = side === "after" ? to.x + to.width - 3 : to.x + 3;
    await this.page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await this.page.mouse.down();
    await this.page.mouse.move(targetX, to.y + to.height / 2, { steps: 10 });
    await this.page.mouse.up();
  }
}
