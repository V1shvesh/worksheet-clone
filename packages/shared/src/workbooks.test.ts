import { describe, expect, it } from "vitest";
import { addMemberSchema, changeRoleSchema, createWorkbookSchema } from "./workbooks.js";

describe("createWorkbookSchema", () => {
  it("trims the name", () => {
    expect(createWorkbookSchema.parse({ name: "  Budget  " })).toEqual({ name: "Budget" });
  });

  it("rejects a blank or too-long name", () => {
    expect(createWorkbookSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(createWorkbookSchema.safeParse({ name: "x".repeat(101) }).success).toBe(false);
  });
});

describe("addMemberSchema / changeRoleSchema", () => {
  it("accepts editor and viewer", () => {
    expect(addMemberSchema.safeParse({ email: "b@example.com", role: "viewer" }).success).toBe(
      true,
    );
    expect(changeRoleSchema.safeParse({ role: "editor" }).success).toBe(true);
  });

  it("never allows assigning owner", () => {
    expect(addMemberSchema.safeParse({ email: "b@example.com", role: "owner" }).success).toBe(
      false,
    );
    expect(changeRoleSchema.safeParse({ role: "owner" }).success).toBe(false);
  });
});
