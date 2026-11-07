import type { FastifyInstance } from "fastify";
import {
  createWorkbookSchema,
  renameWorkbookSchema,
  workbookParamsSchema,
  type WorkbookSummary,
} from "@worksheet-clone/shared";
import {
  createWorkbook,
  deleteWorkbook,
  getWorkbook,
  listWorkbooks,
  renameWorkbook,
  type WorkbookWithRole,
} from "../domain/workbooks.js";
import { parseOrThrow } from "./errors.js";
import { currentUser, requireUser } from "./session.js";

function toSummary(workbook: WorkbookWithRole): WorkbookSummary {
  return {
    id: workbook.id,
    name: workbook.name,
    role: workbook.role,
    createdAt: workbook.createdAt.toISOString(),
    updatedAt: workbook.updatedAt.toISOString(),
  };
}

export function registerWorkbookRoutes(app: FastifyInstance): void {
  void app.register(async (scope) => {
    scope.addHook("preHandler", requireUser);

    scope.get("/api/workbooks", async (request) => {
      const workbooks = await listWorkbooks(currentUser(request).id);
      return { workbooks: workbooks.map(toSummary) };
    });

    scope.post("/api/workbooks", async (request, reply) => {
      const { name } = parseOrThrow(createWorkbookSchema, request.body);
      const workbook = await createWorkbook(currentUser(request).id, name);
      reply.code(201);
      return { workbook: toSummary(workbook) };
    });

    // A malformed id can't name a workbook, so it's NOT_FOUND like any other
    // unknown id (and never reaches Postgres as an invalid uuid).
    scope.get("/api/workbooks/:id", async (request) => {
      const { id } = parseOrThrow(workbookParamsSchema, request.params, "NOT_FOUND");
      return { workbook: toSummary(await getWorkbook(currentUser(request).id, id)) };
    });

    scope.patch("/api/workbooks/:id", async (request) => {
      const { id } = parseOrThrow(workbookParamsSchema, request.params, "NOT_FOUND");
      const { name } = parseOrThrow(renameWorkbookSchema, request.body);
      return { workbook: toSummary(await renameWorkbook(currentUser(request).id, id, name)) };
    });

    scope.delete("/api/workbooks/:id", async (request, reply) => {
      const { id } = parseOrThrow(workbookParamsSchema, request.params, "NOT_FOUND");
      await deleteWorkbook(currentUser(request).id, id);
      return reply.code(204).send();
    });
  });
}
