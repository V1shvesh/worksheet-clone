import type { FastifyInstance } from "fastify";
import { loginSchema, signupSchema } from "@worksheet-clone/shared";
import { createSession, deleteSession, login, signup } from "../domain/auth.js";
import { parseOrThrow } from "./errors.js";
import type { RateLimits } from "./rate-limits.js";
import {
  clearSessionCookie,
  requireUser,
  SESSION_COOKIE_NAME,
  setSessionCookie,
} from "./session.js";

// The @fastify/rate-limit plugin is registered (and awaited) by registerApiRoutes
// before this runs; the per-route `config.rateLimit` below overrides its global limit.
export function registerAuthRoutes(app: FastifyInstance, limits: RateLimits): void {
  app.post(
    "/api/auth/signup",
    { config: { rateLimit: { max: limits.signupPerHour, timeWindow: "1 hour" } } },
    async (request, reply) => {
      const { email, password } = parseOrThrow(signupSchema, request.body);
      const user = await signup(email, password);
      const session = await createSession(user.id);
      setSessionCookie(reply, session.id);
      reply.code(201);
      return { user };
    },
  );

  app.post(
    "/api/auth/login",
    { config: { rateLimit: { max: limits.loginPerMinute, timeWindow: "1 minute" } } },
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
