import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE_NAME } from "../../src/http/session.js";

export interface TestClient {
  id: string;
  email: string;
  cookies: Record<string, string>;
}

export function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ""];
  const match = headers[0]?.match(new RegExp(`^${SESSION_COOKIE_NAME}=([^;]+)`));
  if (!match?.[1]) {
    throw new Error("session cookie not found in Set-Cookie header");
  }
  return match[1];
}

export async function signupClient(app: FastifyInstance, email: string): Promise<TestClient> {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/signup",
    payload: { email, password: "correct-password" },
  });
  if (response.statusCode !== 201) {
    throw new Error(`signup failed: ${response.statusCode} ${response.body}`);
  }
  const { user } = response.json() as { user: { id: string; email: string } };
  return {
    ...user,
    cookies: { [SESSION_COOKIE_NAME]: extractSessionCookie(response.headers["set-cookie"]) },
  };
}
