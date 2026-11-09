import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { readColOrder, readRowOrder, readSheetOrder } from "@worksheet-clone/shared";
import { BOB } from "./fixtures/collab";
import { openWorkbook } from "./fixtures/grid-workbook";
import { me } from "./fixtures/workbooks";

const workbookId = "00000000-0000-4000-8000-000000000081";
const cacheName = `worksheet:${me.id}:${workbookId}`;

const connection = (page: Page) => page.getByRole("status", { name: "Connection" });
const banner = (page: Page) => page.getByTestId("access-banner");
const dbNames = (page: Page) =>
  page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name));
/** How many Yjs updates the on-device copy holds (0 while its database does not exist yet). */
const cachedUpdates = (page: Page) =>
  page
    .evaluate(
      (name) =>
        new Promise<number>((resolve, reject) => {
          const open = indexedDB.open(name);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains("updates")) {
              db.close();
              resolve(0);
              return;
            }
            const count = db.transaction("updates").objectStore("updates").count();
            count.onsuccess = () => {
              db.close();
              resolve(count.result);
            };
            count.onerror = () => reject(count.error);
          };
        }),
      cacheName,
    )
    .catch(() => 0);

test("offline -> edits -> reconnect: both sides merge, nothing is duplicated", async ({
  page,
  context,
}) => {
  const { grid, tabs, collab, serverCell, remote, serverDoc } = await setup(page);

  await context.setOffline(true);
  collab.refuseConnections(true);
  collab.dropConnections();
  await expect(connection(page)).toHaveText("Offline — changes are kept on this device");

  await grid.typeInto(0, 0, "5");
  await grid.typeInto(1, 0, "=A1*2");
  await grid.typeInto(0, 1, "kept");
  await expect(grid.cell(1, 0)).toHaveText("10");
  // The page's edits are not on the server, and Bob changes other cells there meanwhile.
  expect(serverCell(0, 0)).toBeUndefined();
  await remote((set) => {
    set(0, 3, { v: "bob D1" });
    set(1, 3, { v: "bob D2" });
  }, BOB);
  await expect(grid.cell(0, 3)).toHaveText("");

  collab.refuseConnections(false);
  await context.setOffline(false);
  await expect(connection(page)).toHaveText("All changes saved", { timeout: 20_000 });

  // The page sees Bob's cells and keeps its own...
  await expect(grid.cell(0, 3)).toHaveText("bob D1");
  await expect(grid.cell(1, 3)).toHaveText("bob D2");
  await expect(grid.cell(0, 0)).toHaveText("5");
  await expect(grid.cell(1, 0)).toHaveText("10");
  await expect(grid.cell(0, 1)).toHaveText("kept");
  // ...and so does the server, with exactly one of everything.
  await expect.poll(() => serverCell(0, 1)).toEqual({ v: "kept" });
  expect(serverCell(0, 0)).toEqual({ v: 5 });
  expect(serverCell(1, 0)?.f).toBeDefined();
  expect(serverCell(0, 3)).toEqual({ v: "bob D1" });
  expect(serverCell(1, 3)).toEqual({ v: "bob D2" });
  const doc = serverDoc();
  const sheets = readSheetOrder(doc);
  expect(sheets).toHaveLength(1);
  expect(readRowOrder(doc, sheets[0] ?? "")).toHaveLength(100);
  expect(readColOrder(doc, sheets[0] ?? "")).toHaveLength(26);
  await tabs.expectNames(["Sheet1"]);
});

test("offline -> reopen the page -> online: edits survive on the device and reach the server", async ({
  page,
  context,
}) => {
  const { grid, collab, serverCell } = await setup(page);

  await context.setOffline(true);
  collab.refuseConnections(true);
  collab.dropConnections();
  await expect(connection(page)).toHaveText("Offline — changes are kept on this device");
  const before = await cachedUpdates(page);
  await grid.typeInto(0, 0, "kept offline");
  await expect.poll(() => cachedUpdates(page)).toBeGreaterThan(before);

  // The tab is closed and reopened (a reload keeps the browser's IndexedDB) while the server
  // is still unreachable: the grid comes up from the on-device copy.
  await context.setOffline(false);
  await page.reload();
  await expect(grid.cell(0, 0)).toHaveText("kept offline");
  expect(serverCell(0, 0)).toBeUndefined();

  collab.refuseConnections(false);
  await expect(connection(page)).toHaveText("All changes saved", { timeout: 20_000 });
  await expect.poll(() => serverCell(0, 0)).toEqual({ v: "kept offline" });
  await expect(grid.cell(0, 0)).toHaveText("kept offline");
});

test("kicked to viewer with unconfirmed edits: banner, CSV download, reload shows the server's state", async ({
  page,
}) => {
  const { grid, collab, serverCell, remote } = await setup(page);
  await remote((set) => set(0, 1, { v: "server B1" }), BOB);
  await expect(grid.cell(0, 1)).toHaveText("server B1");

  // The edit stays on the page: the uplink stalls before the owner demotes this user.
  collab.holdUplink();
  await grid.typeInto(0, 0, "mine");
  await expect(connection(page)).toHaveText("Saving…");
  collab.setAccess("readonly");
  collab.kick();
  await collab.releaseUplink();

  await expect(banner(page)).toHaveText(/Your access changed to view only/, { timeout: 20_000 });
  await expect(banner(page)).toHaveAttribute("role", "alert");
  await expect(connection(page)).toHaveText("All changes saved · View only");
  await expect(grid.cell(0, 0)).toHaveText("mine");
  expect(serverCell(0, 0)).toBeUndefined();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download unsaved changes" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("Tools - Sheet1.csv");
  // UTF-8 BOM, then every non-empty cell of the replica (Bob's B1 too: see recoveryFiles).
  expect(await readFile(await file.path(), "utf8")).toBe("﻿mine,server B1\r\n");

  await page.getByRole("button", { name: "Reload" }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect(grid.cell(0, 0)).toHaveText("");
  await expect(grid.cell(0, 1)).toHaveText("server B1");
  await expect(connection(page)).toHaveText("All changes saved · View only");

  // Editing is refused now.
  await grid.clickCell(0, 0);
  await page.keyboard.type("nope");
  await page.keyboard.press("Enter");
  await expect(grid.cell(0, 0)).toHaveText("");
  await expect(grid.editor()).toHaveCount(0);
  expect(serverCell(0, 0)).toBeUndefined();

  // The dropped edit is not on the device either: it does not come back after a page reload.
  await page.reload();
  await expect(grid.cell(0, 1)).toHaveText("server B1");
  await expect(grid.cell(0, 0)).toHaveText("");
  await expect(banner(page)).toHaveCount(0);
});

test("document too large (4413): banner, no reconnect, CSV download, reload resumes editing", async ({
  page,
}) => {
  const { grid, collab, serverCell, remote } = await setup(page);
  await remote((set) => set(0, 1, { v: "server B1" }), BOB);
  await expect(grid.cell(0, 1)).toHaveText("server B1");

  // The change that breaks the cap never reaches the server: the uplink stalls, then it closes.
  collab.holdUplink();
  await grid.typeInto(0, 0, "too big");
  await expect(connection(page)).toHaveText("Saving…");
  collab.kickTooLarge();
  const opened = collab.connectionCount();
  await collab.releaseUplink(); // the closed socket discarded what was held; new sockets must flow

  await expect(banner(page)).toHaveText(
    /This workbook reached its size limit \(10 MB\)\. Your last change wasn't saved\./,
    { timeout: 20_000 },
  );
  await expect(banner(page)).toHaveAttribute("role", "alert");
  await expect(connection(page)).toHaveText("Not connected");
  expect(serverCell(0, 0)).toBeUndefined();

  // Editing has stopped, and the provider does not reconnect and resend the change.
  await grid.clickCell(0, 2);
  await page.keyboard.type("nope");
  await page.keyboard.press("Enter");
  await expect(grid.cell(0, 2)).toHaveText("");
  await page.waitForTimeout(2500); // longer than the provider's reconnect delay
  expect(collab.connectionCount()).toBe(opened);
  await expect(connection(page)).toHaveText("Not connected");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download unsaved changes" }).click();
  const file = await download;
  expect(await readFile(await file.path(), "utf8")).toBe(
    `${String.fromCharCode(0xfeff)}too big,server B1\r\n`,
  );

  await page.getByRole("button", { name: "Reload" }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect(grid.cell(0, 0)).toHaveText("");
  await expect(grid.cell(0, 1)).toHaveText("server B1");
  await expect(connection(page)).toHaveText("All changes saved");
  await grid.typeInto(0, 2, "again");
  await expect.poll(() => serverCell(0, 2)).toEqual({ v: "again" });
});

test("kicked to viewer without unconfirmed edits: just the notice", async ({ page }) => {
  const { grid, collab, remote } = await setup(page);
  await remote((set) => set(0, 1, { v: "server B1" }), BOB);
  await expect(grid.cell(0, 1)).toHaveText("server B1");

  collab.setAccess("readonly");
  collab.kick();

  await expect(banner(page)).toHaveText(/Your access changed to view only/, { timeout: 20_000 });
  await expect(connection(page)).toHaveText("All changes saved · View only");
  // Nothing to export and nothing to reset: the replica already equals the server.
  await expect(banner(page).getByRole("button")).toHaveCount(0);
  await expect(grid.cell(0, 1)).toHaveText("server B1");
});

test("removed: banner, no editing, link back, on-device copy gone", async ({ page }) => {
  const { grid, collab, workbooks, serverCell } = await setup(page);
  await expect.poll(() => dbNames(page)).toContain(cacheName);

  // The owner removes this user: REST stops finding the workbook, the socket is closed, and the
  // reconnect is refused.
  workbooks.delete(workbookId);
  collab.setAccess("denied");
  collab.kick("access-changed");

  await expect(banner(page)).toHaveText(/You no longer have access to this workbook/, {
    timeout: 20_000,
  });
  await expect(connection(page)).toHaveText("Not connected");
  await expect(banner(page).getByRole("button")).toHaveCount(0);
  await expect.poll(() => dbNames(page)).not.toContain(cacheName);

  await grid.clickCell(0, 0);
  await page.keyboard.type("nope");
  await page.keyboard.press("Enter");
  await expect(grid.cell(0, 0)).toHaveText("");
  expect(serverCell(0, 0)).toBeUndefined();

  await banner(page).getByRole("link", { name: "Back to all workbooks" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("deleted workbook: says so", async ({ page }) => {
  const { collab, workbooks } = await setup(page);

  workbooks.delete(workbookId);
  collab.setAccess("denied");
  collab.kick("workbook-deleted");

  await expect(banner(page)).toHaveText(/This workbook was deleted/, { timeout: 20_000 });
  await expect(banner(page).getByRole("link", { name: "Back to all workbooks" })).toBeVisible();
  await expect(connection(page)).toHaveText("Not connected");
});

test("save failing: the indicator says so and recovers, without toasts", async ({ page }) => {
  const { grid, collab } = await setup(page);

  collab.reportSaveFailing(workbookId);
  await expect(connection(page)).toHaveText("Not saved — retrying");
  collab.reportSaveFailing(workbookId);
  collab.reportSaveFailing(workbookId);

  collab.reportSaveRecovered(workbookId);
  await expect(connection(page)).toHaveText("All changes saved");
  await expect(grid.toasts()).toHaveCount(0);
});

async function setup(page: Page) {
  const opened = await openWorkbook(page, workbookId);
  return { ...opened, serverDoc: () => opened.collab.serverDoc(workbookId)! };
}
