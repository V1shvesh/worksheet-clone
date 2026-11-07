import type { FastifyInstance } from "fastify";
import {
  addMemberSchema,
  changeRoleSchema,
  memberParamsSchema,
  workbookParamsSchema,
} from "@worksheet-clone/shared";
import { addMember, changeMemberRole, listMembers, removeMember } from "../domain/members.js";
import { revokeUserAccess } from "../realtime/access.js";
import { parseOrThrow } from "./errors.js";
import { currentUser, requireUser } from "./session.js";

export function registerMemberRoutes(app: FastifyInstance): void {
  void app.register(async (scope) => {
    scope.addHook("preHandler", requireUser);

    scope.get("/api/workbooks/:id/members", async (request) => {
      const { id } = parseOrThrow(workbookParamsSchema, request.params, "NOT_FOUND");
      return { members: await listMembers(currentUser(request).id, id) };
    });

    scope.post("/api/workbooks/:id/members", async (request, reply) => {
      const { id } = parseOrThrow(workbookParamsSchema, request.params, "NOT_FOUND");
      const { email, role } = parseOrThrow(addMemberSchema, request.body);
      const member = await addMember(currentUser(request).id, id, email, role);
      reply.code(201);
      return { member };
    });

    scope.patch("/api/workbooks/:id/members/:userId", async (request) => {
      const { id, userId } = parseOrThrow(memberParamsSchema, request.params, "NOT_FOUND");
      const { role } = parseOrThrow(changeRoleSchema, request.body);
      const member = await changeMemberRole(currentUser(request).id, id, userId, role);
      revokeUserAccess(app.collab, id, userId);
      return { member };
    });

    scope.delete("/api/workbooks/:id/members/:userId", async (request, reply) => {
      const { id, userId } = parseOrThrow(memberParamsSchema, request.params, "NOT_FOUND");
      await removeMember(currentUser(request).id, id, userId);
      revokeUserAccess(app.collab, id, userId);
      return reply.code(204).send();
    });
  });
}
