import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthRoute } from "./http/health.js";

const webDistDir = fileURLToPath(new URL("../../web/dist", import.meta.url));

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  registerHealthRoute(app);

  if (process.env.NODE_ENV === "production" && existsSync(webDistDir)) {
    void app.register(fastifyStatic, {
      root: webDistDir,
      wildcard: false,
    });

    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/")) {
        void reply.sendFile("index.html");
        return;
      }
      void reply.code(404).send({ error: { code: "not_found", message: "Not found" } });
    });
  }

  return app;
}
