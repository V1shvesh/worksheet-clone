import cookie from "@fastify/cookie";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthUser } from "@worksheet-clone/shared";
import { config } from "../config.js";
import { getSessionUser } from "../domain/auth.js";
import { DomainError } from "../domain/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export const SESSION_COOKIE_NAME = "session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export function registerSessionPlugin(app: FastifyInstance): void {
  void app.register(cookie, { secret: config.cookieSecret });
}

export function setSessionCookie(reply: FastifyReply, sessionId: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
    path: "/",
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    signed: true,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

export async function requireUser(request: FastifyRequest): Promise<void> {
  const raw = request.cookies[SESSION_COOKIE_NAME];
  const unsigned = raw ? request.unsignCookie(raw) : null;

  if (!unsigned?.valid || !unsigned.value) {
    throw new DomainError("UNAUTHORIZED", "Not logged in");
  }

  const user = await getSessionUser(unsigned.value);
  if (!user) {
    throw new DomainError("UNAUTHORIZED", "Session expired");
  }

  request.user = user;
}

export function currentUser(request: FastifyRequest): AuthUser {
  if (!request.user) {
    throw new DomainError("UNAUTHORIZED", "Not logged in");
  }
  return request.user;
}
