import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { GridPage } from "../pages/grid-page";

/**
 * Full-stack smoke test: the production image, a real Postgres, real WebSockets.
 * Nothing is mocked. Signup is rate limited to 5 per hour per IP in production mode and the
 * counters live in the app's memory, so a run uses 2 signups; after two runs within an hour
 * restart the app (`docker compose -f docker/docker-compose.prod.yml restart app`).
 */
test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);
const password = "smoke-test-password-1";
const alice = { email: `alice-${run}@smoke.test` };
const bob = { email: `bob-${run}@smoke.test` };
const workbookName = `Smoke ${run}`;

interface Watched {
  cspViolations: string[];
  consoleErrors: string[];
  sockets: { url: string; closed: boolean }[];
}

async function signUp(
  context: BrowserContext,
  email: string,
): Promise<{ page: Page; seen: Watched }> {
  const page = await context.newPage();
  const seen: Watched = { cspViolations: [], consoleErrors: [], sockets: [] };
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`CSPVIOLATION ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("CSPVIOLATION") || /content security policy/i.test(text)) {
      seen.cspViolations.push(text);
    } else if (message.type() === "error") {
      seen.consoleErrors.push(text);
    }
  });
  page.on("websocket", (socket) => {
    const entry = { url: socket.url(), closed: false };
    seen.sockets.push(entry);
    socket.on("close", () => (entry.closed = true));
  });
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  return { page, seen };
}

const connection = (page: Page) => page.getByRole("status", { name: "Connection" });

async function openWorkbook(page: Page, grid: GridPage) {
  await page.getByRole("link", { name: workbookName }).click();
  await expect(connection(page)).toContainText("All changes saved");
  await expect(grid.cell(0, 0)).toBeVisible();
}

let aliceCtx: BrowserContext;
let bobCtx: BrowserContext;
let a: { page: Page; seen: Watched };
let b: { page: Page; seen: Watched };

test.beforeAll(async ({ browser }) => {
  aliceCtx = await browser.newContext();
  bobCtx = await browser.newContext();
});
test.afterAll(async () => {
  await aliceCtx.close();
  await bobCtx.close();
});

test("two users sign up; the owner shares a workbook as editor", async () => {
  a = await signUp(aliceCtx, alice.email);
  b = await signUp(bobCtx, bob.email);

  await a.page.getByLabel("New workbook name").fill(workbookName);
  await a.page.getByRole("button", { name: "Create workbook" }).click();
  await expect(a.page.getByRole("link", { name: workbookName })).toBeVisible();

  await a.page.getByRole("button", { name: `Members of ${workbookName}` }).click();
  const dialog = a.page.getByRole("dialog");
  const form = dialog.getByRole("form", { name: "Add a person" });
  await form.getByLabel("Email").fill(bob.email);
  await form.getByRole("button", { name: "Add" }).click();
  const role = dialog.getByLabel(`Role for ${bob.email}`);
  await role.selectOption("editor");
  await expect(role).toHaveValue("editor");
  await dialog.getByRole("button", { name: "Close" }).click();

  await b.page.reload();
  await expect(
    b.page
      .getByRole("region", { name: "Shared with me" })
      .getByRole("link", { name: workbookName }),
  ).toBeVisible();
});

test("live edits sync both ways, including a formula, and survive a reload", async () => {
  const ga = new GridPage(a.page);
  const gb = new GridPage(b.page);
  await openWorkbook(a.page, ga);
  await b.page
    .getByRole("region", { name: "Shared with me" })
    .getByRole("link", { name: workbookName })
    .click();
  await expect(connection(b.page)).toContainText("All changes saved");
  await expect(gb.cell(0, 0)).toBeVisible();

  await ga.typeInto(0, 0, "5");
  await ga.typeInto(1, 0, "7");
  await ga.typeInto(2, 0, "=SUM(A1:A2)");
  await expect(ga.cell(2, 0)).toHaveText("12");
  await expect(gb.cell(2, 0)).toHaveText("12");

  await gb.typeInto(0, 1, "from bob");
  await expect(ga.cell(0, 1)).toHaveText("from bob");

  // Bob changes an input; Alice's formula recomputes locally from the synced input.
  await gb.typeInto(1, 0, "10");
  await expect(ga.cell(2, 0)).toHaveText("15");

  await expect(connection(a.page)).toContainText("All changes saved");
  await a.page.reload();
  await expect(ga.cell(2, 0)).toHaveText("15");
  await expect(ga.cell(0, 1)).toHaveText("from bob");
});

test("WebSocket connected under the CSP; no CSP violations or console errors", async () => {
  for (const { seen } of [a, b]) {
    const collab = seen.sockets.filter((socket) => new URL(socket.url).pathname === "/collab");
    expect(collab.length).toBeGreaterThan(0);
    expect(seen.cspViolations).toEqual([]);
    expect(seen.consoleErrors).toEqual([]);
  }
  // The most recent socket on each page is still open.
  for (const { seen } of [a, b]) {
    expect(seen.sockets.at(-1)?.closed).toBe(false);
  }
});

test("security headers on the SPA, the API and errors", async ({ request }) => {
  for (const path of ["/", "/api/health", "/api/nope"]) {
    const response = await request.get(path);
    const headers = response.headers();
    const csp = headers["content-security-policy"] ?? "";
    expect(csp, path).toContain("default-src 'self'");
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).not.toContain("unsafe-eval");
    expect(csp.match(/script-src [^;]*/)?.[0], path).toBe("script-src 'self'");
    expect(headers["x-frame-options"], path).toBe("DENY");
    expect(headers["x-content-type-options"], path).toBe("nosniff");
    expect(headers["referrer-policy"], path).toBe("same-origin");
  }
});

test("a cross-origin POST is refused with 403", async ({ request }) => {
  const response = await request.post("/api/auth/login", {
    headers: { Origin: "http://evil.example" },
    data: { email: alice.email, password },
  });
  expect(response.status()).toBe(403);
  expect((await response.json()).error.code).toBe("FORBIDDEN");
});

test("an oversize REST body is refused with 413", async ({ request }) => {
  const response = await request.post("/api/auth/login", {
    data: { email: alice.email, password: "x".repeat(200_000) },
  });
  expect(response.status()).toBe(413);
  expect((await response.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
});
