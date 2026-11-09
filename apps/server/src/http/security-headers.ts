import helmet from "@fastify/helmet";
import type { FastifyInstance } from "fastify";

// One policy for the SPA and the API (the SPA is served by this same server).
// - style-src 'unsafe-inline': AG Grid sets inline styles/<style> tags at runtime.
// - font-src data: / img-src data: : AG Grid's themes inline their icon font and
//   icons as data: URIs in CSS.
// - connect-src 'self': per CSP Level 3, 'self' also matches ws:/wss: on the same
//   host and port, so the /collab WebSocket needs no extra entry (checked in
//   Chromium against the production build, see docs/operations.md).
// - No script 'unsafe-inline'/'unsafe-eval': Vite emits only external module scripts.
export const CONTENT_SECURITY_POLICY = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "script-src-attr": ["'none'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'"],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
} as const;

export interface SecurityHeadersOptions {
  /** Strict-Transport-Security: only meaningful (and only safe) behind HTTPS, i.e. production. */
  hsts: boolean;
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeadersOptions,
): void {
  void app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: Object.fromEntries(
        Object.entries(CONTENT_SECURITY_POLICY).map(([name, sources]) => [name, [...sources]]),
      ),
    },
    strictTransportSecurity: options.hsts ? { maxAge: 15_552_000, includeSubDomains: true } : false,
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "same-origin" },
  });
}
