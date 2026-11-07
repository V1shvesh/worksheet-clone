import type { Role } from "@worksheet-clone/shared";
import { DomainError } from "./errors.js";

export const permissions = [
  "workbook:read",
  "workbook:rename",
  "workbook:delete",
  "members:read",
  "members:manage",
  "content:edit",
] as const;

export type Permission = (typeof permissions)[number];

const permissionsByRole: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set(permissions),
  editor: new Set(["workbook:read", "members:read", "content:edit"]),
  viewer: new Set(["workbook:read", "members:read"]),
};

export function can(role: Role, permission: Permission): boolean {
  return permissionsByRole[role].has(permission);
}

export function assertCan(role: Role, permission: Permission): void {
  if (!can(role, permission)) {
    throw new DomainError("FORBIDDEN", "You don't have permission to do that");
  }
}
