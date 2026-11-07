import { describe, expect, it } from "vitest";
import { roles, type Role } from "@worksheet-clone/shared";
import { assertCan, can, permissions, type Permission } from "./acl.js";

// Written out by hand on purpose: a change to the role map must also change
// this table, so permission changes are always deliberate.
const expected: Record<Role, Record<Permission, boolean>> = {
  owner: {
    "workbook:read": true,
    "workbook:rename": true,
    "workbook:delete": true,
    "members:read": true,
    "members:manage": true,
    "content:edit": true,
  },
  editor: {
    "workbook:read": true,
    "workbook:rename": false,
    "workbook:delete": false,
    "members:read": true,
    "members:manage": false,
    "content:edit": true,
  },
  viewer: {
    "workbook:read": true,
    "workbook:rename": false,
    "workbook:delete": false,
    "members:read": true,
    "members:manage": false,
    "content:edit": false,
  },
};

describe("ACL matrix", () => {
  for (const role of roles) {
    for (const permission of permissions) {
      const allowed = expected[role][permission];
      it(`${role} ${allowed ? "can" : "cannot"} ${permission}`, () => {
        expect(can(role, permission)).toBe(allowed);
        if (allowed) {
          expect(() => assertCan(role, permission)).not.toThrow();
        } else {
          expect(() => assertCan(role, permission)).toThrowError(
            expect.objectContaining({ code: "FORBIDDEN" }),
          );
        }
      });
    }
  }
});
