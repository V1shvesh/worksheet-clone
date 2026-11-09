import { expect, test, type Page } from "@playwright/test";
import { openWorkbook } from "./fixtures/grid-workbook";

const workbookId = "00000000-0000-4000-8000-000000000091";
const MIN = 60_000;

const connection = (page: Page) => page.getByRole("status", { name: "Connection" });

/**
 * Headless Chromium never reports a tab as hidden, so the spec overrides `visibilityState` on the
 * document and fires the same `visibilitychange` event a real tab switch does. The app only reads
 * `document.visibilityState` and listens for that event, so this exercises the real code path.
 */
const setVisibility = (page: Page, state: "visible" | "hidden") =>
  page.evaluate((value) => {
    Object.defineProperty(document, "visibilityState", { value, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);

/**
 * Moves the page's clock forward in 10 s steps, with a server message after each. One big jump
 * would make the provider's liveness check (Date.now, 30 s without any message) think the server
 * went silent and drop the socket itself; a real server's traffic prevents that in a real idle tab.
 */
async function elapse(page: Page, collab: { heartbeat(id: string): void }, ms: number) {
  for (let left = ms; left > 0; left -= 10_000) {
    await page.clock.fastForward(Math.min(10_000, left));
    collab.heartbeat(workbookId);
    await page.waitForTimeout(15);
  }
}

test.beforeEach(async ({ page }) => {
  await page.clock.install();
});

test("hidden for 5 minutes: the socket closes; coming back reconnects", async ({ page }) => {
  const { collab } = await openWorkbook(page, workbookId);
  expect(collab.openConnectionCount()).toBe(1);

  await setVisibility(page, "hidden");
  await elapse(page, collab, 4 * MIN);
  expect(collab.openConnectionCount()).toBe(1);
  await elapse(page, collab, MIN + 1000);

  await expect(connection(page)).toHaveText("Paused while you're away");
  await expect(connection(page)).toHaveAttribute("title", "Reconnects when you come back");
  await expect.poll(() => collab.openConnectionCount()).toBe(0);

  await setVisibility(page, "visible");
  await expect(connection(page)).toHaveText("All changes saved");
  expect(collab.openConnectionCount()).toBe(1);
});

test("an edit made while paused reaches the server after resuming", async ({ page }) => {
  const { grid, collab, serverCell } = await openWorkbook(page, workbookId);
  await setVisibility(page, "hidden");
  await elapse(page, collab, 5 * MIN + 1000);
  await expect(connection(page)).toHaveText("Paused while you're away");
  await expect.poll(() => collab.openConnectionCount()).toBe(0);

  // The grid stays editable while paused. Typing is user input, so it also starts a reconnect;
  // make that fail (server unreachable) so the edit provably exists only on this device first.
  collab.refuseConnections(true);
  await grid.typeInto(0, 0, "typed while away");
  await expect(grid.cell(0, 0)).toHaveText("typed while away");
  expect(serverCell(0, 0)).toBeUndefined();

  collab.refuseConnections(false);
  await expect(connection(page)).toHaveText("All changes saved", { timeout: 20_000 });
  expect(serverCell(0, 0)?.v).toBe("typed while away");
});

test("a visible tab with no input for 30 minutes pauses; input resumes", async ({ page }) => {
  const { collab } = await openWorkbook(page, workbookId);
  await elapse(page, collab, 29 * MIN);
  expect(collab.openConnectionCount()).toBe(1);
  await elapse(page, collab, 2 * MIN);
  await expect(connection(page)).toHaveText("Paused while you're away");
  await expect.poll(() => collab.openConnectionCount()).toBe(0);

  await page.mouse.move(50, 50);
  await expect(connection(page)).toHaveText("All changes saved");
  expect(collab.openConnectionCount()).toBe(1);
});

test("unconfirmed changes hold the disconnect until confirmed", async ({ page }) => {
  const { grid, collab, serverCell } = await openWorkbook(page, workbookId);
  collab.holdUplink();
  await grid.typeInto(0, 0, "pending");
  await setVisibility(page, "hidden");
  await elapse(page, collab, 5 * MIN + 1000);
  expect(collab.openConnectionCount()).toBe(1); // still waiting for the server to confirm

  await collab.releaseUplink();
  await expect(connection(page)).toHaveText("Paused while you're away");
  expect(serverCell(0, 0)?.v).toBe("pending");
  await expect.poll(() => collab.openConnectionCount()).toBe(0);
});
