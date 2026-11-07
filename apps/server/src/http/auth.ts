import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { loginSchema, signupSchema } from "@worksheet-clone/shared";
import { createSession, deleteSession, login, signup } from "../domain/auth.js";
import { parseOrThrow } from "./errors.js";
import {
  clearSessionCookie,
  requireUser,
  SESSION_COOKIE_NAME,
  setSessionCookie,
} from "./session.js";

export function registerAuthRoutes(app: FastifyInstance): void {
  // Routes are defined inside this plugin callback (rather than directly on
  // `app`) so that `await scope.register(rateLimit, ...)` finishes booting
  // the rate-limit plugin's `onRoute` hook *before* the routes below are
  // added — adding them directly after a bare `app.register(rateLimit)`
  // runs them too early, since that registration is deferred and the hook
  // isn't attached yet when the synchronous `app.post(...)` calls run.
  void app.register(async (scope) => {
    await scope.register(rateLimit, { global: false });
    registerRoutes(scope);
  });
}

function registerRoutes(app: FastifyInstance): void {
  app.post("/api/auth/signup", async (request, reply) => {
    const { email, password } = parseOrThrow(signupSchema, request.body);
    const user = await signup(email, password);
    const session = await createSession(user.id);
    setSessionCookie(reply, session.id);
    reply.code(201);
    return { user };
  });

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { email, password } = parseOrThrow(loginSchema, request.body);
      const user = await login(email, password);
      const session = await createSession(user.id);
      setSessionCookie(reply, session.id);
      return { user };
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const raw = request.cookies[SESSION_COOKIE_NAME];
    const unsigned = raw ? request.unsignCookie(raw) : null;
    if (unsigned?.valid && unsigned.value) {
      await deleteSession(unsigned.value);
    }
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.get("/api/auth/me", { preHandler: requireUser }, async (request) => ({
    user: request.user,
  }));
}
