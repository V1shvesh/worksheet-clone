import type { FastifyInstance } from "fastify";
import { healthResponseSchema } from "@worksheet-clone/shared";

export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/api/health", async () => healthResponseSchema.parse({ status: "ok" }));
}
