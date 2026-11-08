import { expect, test, type Page } from "@playwright/test";
import { getSheetName, readSheetOrder, setSheetName } from "@worksheet-clone/shared";
import { mockCollab, type CollabAccess } from "./fixtures/collab";
import { mockApiFallback, mockSession } from "./fixtures/session";
import { SheetTabsPage } from "./pages/sheet-tabs-page";
import { me, mockWorkbooks, workbook } from "./fixtures/workbooks";

const workbookId = "00000000-0000-4000-8000-000000000021";

async function openWorkbook(page: Page, access: CollabAccess) {
  await mockApiFallback(page);
  await mockSession(page, me);
  await mockWorkbooks(page, [
    workbook(workbookId, "Q3 budget", access === "readonly" ? "viewer" : "owner"),
  ]);
  const collab = await mockCollab(page, { access });
  await page.goto(`/workbooks/${workbookId}`);
  return collab;
}

const connection = (page: Page) => page.getByRole("status", { name: "Connection" });
test("connects and shows the live document", async ({ page }) => {
  await openWorkbook(page, "read-write");

  await expect(page.getByRole("heading", { name: "Q3 budget" })).toBeVisible();
  await expect(connection(page)).toHaveText("All changes saved");
  await new SheetTabsPage(page).expectNames(["Sheet1"]);
});

test("a collaborator's rename appears live", async ({ page }) => {
  const collab = await openWorkbook(page, "read-write");
  await expect(connection(page)).toHaveText("All changes saved");

  await collab.remoteEdit(workbookId, (doc) => {
    setSheetName(doc, readSheetOrder(doc)[0] ?? "", "Renamed by Bob");
  });

  await new SheetTabsPage(page).expectNames(["Renamed by Bob"]);
});

test("a local rename reaches the server", async ({ page }) => {
  const collab = await openWorkbook(page, "read-write");
  await expect(connection(page)).toHaveText("All changes saved");

  const tabs = new SheetTabsPage(page);
  await tabs.rename("Sheet1", "Forecast");

  await tabs.expectNames(["Forecast"]);
  await expect
    .poll(() => {
      const doc = collab.serverDoc(workbookId);
      return doc && getSheetName(doc, readSheetOrder(doc)[0] ?? "");
    })
    .toBe("Forecast");
});

test("a viewer is view-only and can't change the document", async ({ page }) => {
  const collab = await openWorkbook(page, "readonly");
  await expect(connection(page)).toHaveText("All changes saved · View only");

  const tabs = new SheetTabsPage(page);
  await tabs.tab("Sheet1").dblclick();
  await expect(tabs.renameInput()).toHaveCount(0);
  await expect(tabs.addButton()).toHaveCount(0);

  const doc = collab.serverDoc(workbookId);
  expect(doc && getSheetName(doc, readSheetOrder(doc)[0] ?? "")).toBe("Sheet1");
});

test("a denied connection explains itself", async ({ page }) => {
  await openWorkbook(page, "denied");
  // REST still lists the workbook and no close reason was seen: the neutral wording.
  await expect(page.getByTestId("access-banner")).toContainText(
    "This workbook is no longer available to you",
  );
  await expect(connection(page)).toHaveText("Not connected");
});

test("recovers after the connection drops", async ({ page }) => {
  const collab = await openWorkbook(page, "read-write");
  await expect(connection(page)).toHaveText("All changes saved");

  collab.dropConnections();
  await expect(connection(page)).toHaveText("Reconnecting…");

  // An edit made elsewhere while offline arrives once the provider reconnects.
  await collab.remoteEdit(workbookId, (doc) => {
    setSheetName(doc, readSheetOrder(doc)[0] ?? "", "Changed while offline");
  });
  await expect(connection(page)).toHaveText("All changes saved", { timeout: 10_000 });
  await new SheetTabsPage(page).expectNames(["Changed while offline"]);
});
