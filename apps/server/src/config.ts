import { z } from "zod";

const DEV_DATABASE_URL = "postgres://worksheet:worksheet@localhost:5432/worksheet";
const DEV_COOKIE_SECRET = "dev-only-insecure-cookie-secret-change-me";

export const MIN_COOKIE_SECRET_LENGTH = 32;

// Empty strings count as unset: `FOO=` in a compose file or Railway's UI is
// "not configured", never a value.
const blankToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalString = z.preprocess(blankToUndefined, z.string().optional());

// TRUST_PROXY: "true" trusts every hop in X-Forwarded-For, a positive integer
// trusts that many proxies (Railway: usually 1). Anything else is rejected so
// a typo can't silently leave request.ip spoofable or point at the proxy.
const trustProxy = z.preprocess(
  blankToUndefined,
  z
    .string()
    .regex(/^(true|false|[1-9][0-9]*)$/, 'must be "true", "false" or a positive integer')
    .optional()
    .transform((value): boolean | number => {
      if (value === undefined || value === "false") return false;
      if (value === "true") return true;
      return Number(value);
    }),
);

const envSchema = z.object({
  NODE_ENV: z.preprocess(
    blankToUndefined,
    z.enum(["development", "test", "production"]).default("development"),
  ),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).max(65535).default(3000)),
  DATABASE_URL: optionalString,
  DATABASE_URL_UNPOOLED: optionalString,
  COOKIE_SECRET: optionalString,
  WEB_DIST_DIR: optionalString,
  TRUST_PROXY: trustProxy,
});

export interface Config {
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;
  port: number;
  /** Pooled URL the app queries through. */
  databaseUrl: string;
  /** Direct (non-pooled) URL for migrations and advisory locks; falls back to databaseUrl. */
  databaseUrlUnpooled: string;
  cookieSecret: string;
  webDistDir: string | undefined;
  /** Passed to Fastify's trustProxy: false = ignore X-Forwarded-*. */
  trustProxy: boolean | number;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Pure: parses and validates an environment, throwing ConfigError listing every problem. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(env);
  const problems: string[] = [];
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    );
  }

  const values = parsed.data;
  const isProduction = values.NODE_ENV === "production";

  // No dev fallbacks in production: a missing secret or database must stop
  // the process, never quietly run with a published default.
  if (isProduction && !values.DATABASE_URL) {
    problems.push("DATABASE_URL: required in production");
  }
  if (isProduction) {
    if (!values.COOKIE_SECRET) {
      problems.push("COOKIE_SECRET: required in production");
    } else if (values.COOKIE_SECRET.length < MIN_COOKIE_SECRET_LENGTH) {
      problems.push(`COOKIE_SECRET: must be at least ${MIN_COOKIE_SECRET_LENGTH} characters`);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  const databaseUrl = values.DATABASE_URL ?? DEV_DATABASE_URL;
  return {
    nodeEnv: values.NODE_ENV,
    isProduction,
    port: values.PORT,
    databaseUrl,
    databaseUrlUnpooled: values.DATABASE_URL_UNPOOLED ?? databaseUrl,
    cookieSecret: values.COOKIE_SECRET ?? DEV_COOKIE_SECRET,
    webDistDir: values.WEB_DIST_DIR,
    trustProxy: values.TRUST_PROXY,
  };
}

function loadConfigOrExit(): Config {
  try {
    return parseConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

// Evaluated once, when first imported. main.ts imports this module before
// anything that reads it, so a bad environment exits with this message and
// not a stack trace from deeper in. Tests set DATABASE_URL before importing.
export const config: Config = loadConfigOrExit();
