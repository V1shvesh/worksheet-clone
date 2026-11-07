import { z } from "zod";

export const roles = ["owner", "editor", "viewer"] as const;
export const roleSchema = z.enum(roles);
export type Role = z.infer<typeof roleSchema>;

export const assignableRoleSchema = z.enum(["editor", "viewer"]);
export type AssignableRole = z.infer<typeof assignableRoleSchema>;

export const workbookNameSchema = z.string().trim().min(1).max(100);

export const createWorkbookSchema = z.object({ name: workbookNameSchema });
export type CreateWorkbookInput = z.infer<typeof createWorkbookSchema>;

export const renameWorkbookSchema = z.object({ name: workbookNameSchema });
export type RenameWorkbookInput = z.infer<typeof renameWorkbookSchema>;

export const workbookSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  role: roleSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type WorkbookSummary = z.infer<typeof workbookSummarySchema>;

export const memberSchema = z.object({
  userId: z.string().uuid(),
  email: z.string().email(),
  role: roleSchema,
});
export type Member = z.infer<typeof memberSchema>;

export const addMemberSchema = z.object({
  email: z.string().trim().email(),
  role: assignableRoleSchema,
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const changeRoleSchema = z.object({ role: assignableRoleSchema });
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;
