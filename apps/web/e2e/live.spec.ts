import { expect, test, type Page } from "@playwright/test";
import { getSheetName, readSheetOrder, setSheetName } from "@worksheet-clone/shared";
import { mockCollab, type CollabAccess } from "./fixtures/collab";
import { mockApiFallback, mockSession } from "./fixtures/session";
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
const sheets = (page: Page) => page.getByRole("list", { name: "Sheets" });
const sheetNameField = (page: Page) => page.getByLabel("First sheet name");

test("connects and shows the live document", async ({ page }) => {
  await openWorkbook(page, "read-write");

  await expect(page.getByRole("heading", { name: "Q3 budget" })).toBeVisible();
  await expect(connection(page)).toHaveText("Live");
  await expect(sheets(page)).toHaveText("Sheet1");
});

test("a collaborator's rename appears live", async ({ page }) => {
  const collab = await openWorkbook(page, "read-write");
  await expect(connection(page)).toHaveText("Live");

  await collab.remoteEdit(workbookId, (doc) => {
    setSheetName(doc, readSheetOrder(doc)[0] ?? "", "Renamed by Bob");
  });

  await expect(sheets(page)).toHaveText("Renamed by Bob");
  await expect(sheetNameField(page)).toHaveValue("Renamed by Bob");
});

test("a local rename reaches the server", async ({ page }) => {
  const collab = await openWorkbook(page, "read-write");
  await expect(connection(page)).toHaveText("Live");

  await sheetNameField(page).fill("Forecast");
  await sheetNameField(page).press("Enter");

  await expect(sheets(page)).toHaveText("Forecast");
  await expect
    .poll(() => {
      const doc = collab.serverDoc(workbookId);
      return doc && getSheetName(doc, readSheetOrder(doc)[0] ?? "");
    })
    .toBe("Forecast");
});

test("a viewer is view-only and can't change the document", async ({ page }) => {
  const collab = await openWorkbook(page, "readonly");
  await expect(connection(page)).toHaveText("Live · View only");
  await expect(sheetNameField(page)).toHaveAttribute("readonly", "");

  await sheetNameField(page).click();
  await page.keyboard.type("Sneaky");
  await page.keyboard.press("Enter");

  await expect(sheetNameField(page)).toHaveValue("Sheet1");
  const doc = collab.serverDoc(workbookId);
  expect(doc && getSheetName(doc, readSheetOrder(doc)[0] ?? "")).toBe("Sheet1");
});

test("a denied connection explains itself", async ({ page }) => {
  await openWorkbook(page, "denied");
  await expect(page.getByRole("alert")).toHaveText(
    "You don't have access to this workbook anymore.",
  );
});

test("recovers after the connection drops", async ({ page }) => {
  const collab = await openWorkbook(page, "read-write");
  await expect(connection(page)).toHaveText("Live");

  collab.dropConnections();
  await expect(connection(page)).toHaveText("Offline — reconnecting…");

  // An edit made elsewhere while offline arrives once the provider reconnects.
  await collab.remoteEdit(workbookId, (doc) => {
    setSheetName(doc, readSheetOrder(doc)[0] ?? "", "Changed while offline");
  });
  await expect(connection(page)).toHaveText("Live", { timeout: 10_000 });
  await expect(sheets(page)).toHaveText("Changed while offline");
});
