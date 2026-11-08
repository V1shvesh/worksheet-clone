import type { Page, Route } from "@playwright/test";
import type { Member, Role, WorkbookSummary } from "@worksheet-clone/shared";
import { json } from "./session";

export const me = { id: "00000000-0000-4000-8000-000000000001", email: "me@example.com" };

interface MockWorkbook {
  summary: WorkbookSummary;
  members: Member[];
}

const now = "2026-11-07T10:00:00.000Z";

export function workbook(id: string, name: string, role: Role): MockWorkbook {
  const owner: Member =
    role === "owner"
      ? { userId: me.id, email: me.email, role: "owner" }
      : { userId: `owner-${id}`, email: `owner-of-${id}@example.com`, role: "owner" };
  const members = role === "owner" ? [owner] : [owner, { userId: me.id, email: me.email, role }];
  return { summary: { id, name, role, createdAt: now, updatedAt: now }, members };
}

function notFound(route: Route) {
  return route.fulfill(json(404, { error: { code: "NOT_FOUND", message: "Workbook not found" } }));
}

// In-memory stand-in for the workbook + member endpoints, enforcing the same
// owner-only rules as the server so the UI is tested against real responses.
export async function mockWorkbooks(
  page: Page,
  initial: MockWorkbook[],
  knownUsers: string[] = [],
  hooks: { onRenamed?: (id: string, from: string, to: string) => void } = {},
) {
  const store = new Map(initial.map((w) => [w.summary.id, w]));
  let nextId = 100;

  await page.route("**/api/workbooks", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      return route.fulfill(json(200, { workbooks: [...store.values()].map((w) => w.summary) }));
    }
    const { name } = request.postDataJSON() as { name: string };
    const created = workbook(
      `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`,
      name.trim(),
      "owner",
    );
    store.set(created.summary.id, created);
    return route.fulfill(json(201, { workbook: created.summary }));
  });

  await page.route(/\/api\/workbooks\/([^/]+)$/, async (route) => {
    const id = route.request().url().split("/").pop() ?? "";
    const entry = store.get(id);
    if (!entry) return notFound(route);
    if (route.request().method() === "DELETE") {
      if (entry.summary.role !== "owner") {
        return route.fulfill(
          json(403, {
            error: { code: "FORBIDDEN", message: "You don't have permission to do that" },
          }),
        );
      }
      store.delete(id);
      return route.fulfill({ status: 204, body: "" });
    }
    if (route.request().method() === "PATCH") {
      if (entry.summary.role !== "owner") {
        return route.fulfill(
          json(403, {
            error: { code: "FORBIDDEN", message: "You don't have permission to do that" },
          }),
        );
      }
      const { name } = route.request().postDataJSON() as { name: string };
      const from = entry.summary.name;
      entry.summary = { ...entry.summary, name: name.trim() };
      hooks.onRenamed?.(id, from, entry.summary.name);
      return route.fulfill(json(200, { workbook: entry.summary }));
    }
    return route.fulfill(json(200, { workbook: entry.summary }));
  });

  await page.route(/\/api\/workbooks\/([^/]+)\/members(\/[^/]+)?$/, async (route) => {
    const [, id, userPath] =
      /\/api\/workbooks\/([^/]+)\/members(\/[^/]+)?$/.exec(route.request().url()) ?? [];
    const entry = id ? store.get(id) : undefined;
    if (!entry) return notFound(route);
    const method = route.request().method();

    if (method === "GET") {
      return route.fulfill(json(200, { members: entry.members }));
    }
    if (method === "POST") {
      const { email, role } = route.request().postDataJSON() as { email: string; role: Role };
      if (!knownUsers.includes(email)) {
        return route.fulfill(
          json(404, {
            error: { code: "USER_NOT_FOUND", message: "No account exists with that email" },
          }),
        );
      }
      if (entry.members.some((m) => m.email === email)) {
        return route.fulfill(
          json(409, {
            error: {
              code: "ALREADY_MEMBER",
              message: "That person already has access to this workbook",
            },
          }),
        );
      }
      const member: Member = { userId: `user-${email}`, email, role };
      entry.members.push(member);
      return route.fulfill(json(201, { member }));
    }

    const userId = decodeURIComponent(userPath?.slice(1) ?? "");
    const target = entry.members.find((m) => m.userId === userId);
    if (!target) return notFound(route);
    if (method === "PATCH") {
      target.role = (route.request().postDataJSON() as { role: Role }).role;
      return route.fulfill(json(200, { member: target }));
    }
    entry.members = entry.members.filter((m) => m.userId !== userId);
    return route.fulfill({ status: 204, body: "" });
  });

  return store;
}
