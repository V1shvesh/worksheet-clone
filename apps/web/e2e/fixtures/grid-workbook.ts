import { expect, type Page } from "@playwright/test";
import {
  getCell,
  getFormatsMap,
  cellKey,
  readColOrder,
  readRowOrder,
  readSheetOrder,
  setCell,
  type CellData,
  type CellFormat,
} from "@worksheet-clone/shared";
import type * as Y from "yjs";
import { mockCollab, type Author } from "./collab";
import { mockApiFallback, mockSession } from "./session";
import { me, mockWorkbooks, workbook } from "./workbooks";
import { GridPage } from "../pages/grid-page";
import { SheetTabsPage } from "../pages/sheet-tabs-page";

/**
 * Opens a workbook with the stateful REST fixtures and the in-process Hocuspocus, and
 * returns helpers that read the SERVER's copy of the document and edit it as a collaborator.
 * Rows and columns are visual indices on the first sheet unless a sheet id is given.
 */
export async function openWorkbook(
  page: Page,
  workbookId: string,
  access: "read-write" | "readonly" = "read-write",
) {
  await mockApiFallback(page);
  await mockSession(page, me);
  await mockWorkbooks(page, [
    workbook(workbookId, "Tools", access === "readonly" ? "viewer" : "owner"),
  ]);
  const collab = await mockCollab(page, { access });
  await page.goto(`/workbooks/${workbookId}`);
  const grid = new GridPage(page);
  const tabs = new SheetTabsPage(page);
  await expect(grid.cell(0, 0)).toBeVisible();
  await expect(page.getByRole("status", { name: "Connection" })).toContainText("Live");

  const ids = (doc: Y.Doc, row: number, col: number, sheetId?: string) => {
    const sheet = sheetId ?? readSheetOrder(doc)[0]!;
    return [sheet, readRowOrder(doc, sheet)[row]!, readColOrder(doc, sheet)[col]!] as const;
  };
  /** The server's stored cell. */
  const serverCell = (row: number, col: number, sheetId?: string): CellData | undefined | null => {
    const doc = collab.serverDoc(workbookId);
    return doc ? getCell(doc, ...ids(doc, row, col, sheetId)) : null;
  };
  const serverFormat = (row: number, col: number, sheetId?: string): CellFormat | undefined => {
    const doc = collab.serverDoc(workbookId);
    if (!doc) return undefined;
    const [sheet, rowId, colId] = ids(doc, row, col, sheetId);
    return getFormatsMap(doc, sheet).get(cellKey(rowId, colId));
  };
  /** A collaborator's edits as ONE update. */
  const remote = (
    change: (set: (row: number, col: number, data: CellData | undefined) => void) => void,
    author?: Author,
  ) =>
    collab.remoteEdit(
      workbookId,
      (doc) => change((row, col, data) => setCell(doc, ...ids(doc, row, col), data)),
      author,
    );
  const updates = () => collab.countUpdates(workbookId);
  return { grid, tabs, collab, serverCell, serverFormat, remote, updates, ids };
}

export const clipboardPermissions = ["clipboard-read", "clipboard-write"];
