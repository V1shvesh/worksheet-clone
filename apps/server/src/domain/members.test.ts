import { afterAll, afterEach, describe, expect, it } from "vitest";
import { pool } from "../db/client.js";
import { cleanupByEmailPattern, createUser, testEmails } from "../../test/helpers/db.js";
import { addMember, changeMemberRole, listMembers, removeMember } from "./members.js";
import { createWorkbook } from "./workbooks.js";

const emails = testEmails("test-domain-mem");

afterEach(() => cleanupByEmailPattern(emails.pattern));
afterAll(() => pool.end());

async function setup() {
  const owner = await createUser(emails.next());
  const other = await createUser(emails.next());
  const workbook = await createWorkbook(owner.id, "Team");
  return { owner, other, workbook };
}

describe("members", () => {
  it("adds a member by email and lists the owner first", async () => {
    const { owner, other, workbook } = await setup();
    await addMember(owner.id, workbook.id, other.email, "editor");

    expect(await listMembers(other.id, workbook.id)).toEqual([
      { userId: owner.id, email: owner.email, role: "owner" },
      { userId: other.id, email: other.email, role: "editor" },
    ]);
  });

  it("rejects an unknown email and a duplicate member", async () => {
    const { owner, other, workbook } = await setup();

    await expect(
      addMember(owner.id, workbook.id, "nobody-here@example.com", "viewer"),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });

    await addMember(owner.id, workbook.id, other.email, "viewer");
    await expect(addMember(owner.id, workbook.id, other.email, "editor")).rejects.toMatchObject({
      code: "ALREADY_MEMBER",
    });
  });

  it("lets only the owner manage members", async () => {
    const { owner, other, workbook } = await setup();
    const third = await createUser(emails.next());
    await addMember(owner.id, workbook.id, other.email, "editor");

    await expect(addMember(other.id, workbook.id, third.email, "viewer")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(removeMember(other.id, workbook.id, other.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("changes a role and removes a member", async () => {
    const { owner, other, workbook } = await setup();
    await addMember(owner.id, workbook.id, other.email, "viewer");

    expect(await changeMemberRole(owner.id, workbook.id, other.id, "editor")).toMatchObject({
      role: "editor",
    });

    await removeMember(owner.id, workbook.id, other.id);
    await expect(listMembers(other.id, workbook.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("protects the owner from being demoted or removed", async () => {
    const { owner, workbook } = await setup();

    await expect(changeMemberRole(owner.id, workbook.id, owner.id, "viewer")).rejects.toMatchObject(
      { code: "INVALID_MEMBER_OPERATION" },
    );
    await expect(removeMember(owner.id, workbook.id, owner.id)).rejects.toMatchObject({
      code: "INVALID_MEMBER_OPERATION",
    });
  });

  it("returns NOT_FOUND for a target who isn't a member", async () => {
    const { owner, other, workbook } = await setup();

    await expect(removeMember(owner.id, workbook.id, other.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
