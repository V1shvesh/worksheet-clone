import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Member, WorkbookSummary } from "@worksheet-clone/shared";
import { HttpUser, startStack, type Stack } from "./stack.js";

let stack: Stack;

beforeAll(async () => {
  stack = await startStack();
}, 60_000);

afterAll(() => stack?.stop());

async function workbooksOf(user: HttpUser): Promise<WorkbookSummary[]> {
  const response = await user.request("GET", "/api/workbooks");
  expect(response.status).toBe(200);
  return ((await response.json()) as { workbooks: WorkbookSummary[] }).workbooks;
}

describe("M2 done-when: share a workbook as viewer (real server, real Postgres)", () => {
  it("A shares with B as viewer; B sees it but cannot delete it", async () => {
    const alice = new HttpUser(stack, "e2e-alice@example.com");
    const bob = new HttpUser(stack, "e2e-bob@example.com");
    await alice.signup();
    await bob.signup();

    const created = await alice.request("POST", "/api/workbooks", { name: "Q3 budget" });
    expect(created.status).toBe(201);
    const { workbook } = (await created.json()) as { workbook: WorkbookSummary };

    const shared = await alice.request("POST", `/api/workbooks/${workbook.id}/members`, {
      email: bob.email,
      role: "viewer",
    });
    expect(shared.status).toBe(201);
    expect(((await shared.json()) as { member: Member }).member.role).toBe("viewer");

    expect(await workbooksOf(bob)).toEqual([
      expect.objectContaining({ id: workbook.id, name: "Q3 budget", role: "viewer" }),
    ]);

    const bobDelete = await bob.request("DELETE", `/api/workbooks/${workbook.id}`);
    expect(bobDelete.status).toBe(403);
    expect(await bobDelete.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(await workbooksOf(alice)).toHaveLength(1);

    const aliceDelete = await alice.request("DELETE", `/api/workbooks/${workbook.id}`);
    expect(aliceDelete.status).toBe(204);
    expect(await workbooksOf(bob)).toEqual([]);
  });
});
