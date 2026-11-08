import { afterAll, afterEach, describe, expect, it } from "vitest";
import { pool } from "../db/client.js";
import { cleanupByEmailPattern, createUser, testEmails } from "../../test/helpers/db.js";
import { addMember } from "./members.js";
import {
  createWorkbook,
  deleteWorkbook,
  getWorkbook,
  listWorkbooks,
  renameWorkbook,
} from "./workbooks.js";

const emails = testEmails("test-domain-wb");

afterEach(() => cleanupByEmailPattern(emails.pattern));
afterAll(() => pool.end());

describe("workbooks", () => {
  it("creates a workbook owned by its creator", async () => {
    const owner = await createUser(emails.next());
    const workbook = await createWorkbook(owner.id, "Budget");

    expect(workbook).toMatchObject({ name: "Budget", role: "owner" });
    expect(await listWorkbooks(owner.id)).toEqual([
      expect.objectContaining({ id: workbook.id, role: "owner" }),
    ]);
  });

  it("lists shared workbooks with the member's role, and hides others", async () => {
    const owner = await createUser(emails.next());
    const viewer = await createUser(emails.next());
    const stranger = await createUser(emails.next());
    const workbook = await createWorkbook(owner.id, "Shared");
    await addMember(owner.id, workbook.id, viewer.email, "viewer");

    expect(await listWorkbooks(viewer.id)).toEqual([
      expect.objectContaining({ id: workbook.id, role: "viewer" }),
    ]);
    expect(await listWorkbooks(stranger.id)).toEqual([]);
  });

  it("returns NOT_FOUND to non-members instead of FORBIDDEN", async () => {
    const owner = await createUser(emails.next());
    const stranger = await createUser(emails.next());
    const workbook = await createWorkbook(owner.id, "Private");

    await expect(getWorkbook(stranger.id, workbook.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(deleteWorkbook(stranger.id, workbook.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lets only the owner rename and delete", async () => {
    const owner = await createUser(emails.next());
    const editor = await createUser(emails.next());
    const workbook = await createWorkbook(owner.id, "Old name");
    await addMember(owner.id, workbook.id, editor.email, "editor");

    await expect(renameWorkbook(editor.id, workbook.id, "Nope")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(deleteWorkbook(editor.id, workbook.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });

    const renamed = await renameWorkbook(owner.id, workbook.id, "New name");
    expect(renamed.name).toBe("New name");
    expect(renamed.previousName).toBe("Old name");
    expect(renamed.updatedAt.getTime()).toBeGreaterThanOrEqual(workbook.updatedAt.getTime());

    await deleteWorkbook(owner.id, workbook.id);
    expect(await listWorkbooks(owner.id)).toEqual([]);
    expect(await listWorkbooks(editor.id)).toEqual([]);
  });
});
