import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser } from "@worksheet-clone/shared";
import { getSessionUser } from "../domain/auth.js";
import { sendApiError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export const SESSION_COOKIE_NAME = "session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

// Dev-only fallback so local/test runs don't need a .env file; production
// (Railway) always sets COOKIE_SECRET explicitly.
const COOKIE_SECRET = process.env.COOKIE_SECRET ?? "dev-only-insecure-cookie-secret-change-me";

export function registerSessionPlugin(app: FastifyInstance): void {
  void app.register(cookie, { secret: COOKIE_SECRET });
}

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
    path: "/",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    signed: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = request.cookies[SESSION_COOKIE_NAME];
  const unsigned = raw ? request.unsignCookie(raw) : null;

  if (!unsigned?.valid || !unsigned.value) {
    sendApiError(reply, "UNAUTHORIZED", "Not logged in");
    return;
  }

  const user = await getSessionUser(unsigned.value);
  if (!user) {
    sendApiError(reply, "UNAUTHORIZED", "Session expired");
    return;
  }

  request.user = user;
}
