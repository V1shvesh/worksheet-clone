import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "./config.js";

const SECRET = "x".repeat(32);
const production = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://u:p@db.example.com/app?sslmode=require",
  COOKIE_SECRET: SECRET,
};

function problemsOf(env: Record<string, string | undefined>): string {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  throw new Error("expected parseConfig to throw");
}

describe("parseConfig", () => {
  it("gives development local defaults", () => {
    const config = parseConfig({});
    expect(config).toMatchObject({
      nodeEnv: "development",
      isProduction: false,
      port: 3000,
      trustProxy: false,
    });
    expect(config.databaseUrl).toContain("localhost:5432");
    expect(config.cookieSecret.length).toBeGreaterThan(0);
  });

  it("keeps the local defaults in test", () => {
    expect(parseConfig({ NODE_ENV: "test" }).isProduction).toBe(false);
  });

  it("accepts a complete production environment", () => {
    const config = parseConfig({ ...production, PORT: "8080", TRUST_PROXY: "1" });
    expect(config).toMatchObject({ isProduction: true, port: 8080, trustProxy: 1 });
    expect(config.databaseUrl).toBe(production.DATABASE_URL);
    expect(config.cookieSecret).toBe(SECRET);
  });

  it("requires DATABASE_URL and COOKIE_SECRET in production, with no fallback", () => {
    const message = problemsOf({ NODE_ENV: "production" });
    expect(message).toContain("DATABASE_URL: required in production");
    expect(message).toContain("COOKIE_SECRET: required in production");
  });

  it("treats blank values as missing", () => {
    expect(problemsOf({ ...production, COOKIE_SECRET: "  " })).toContain("COOKIE_SECRET");
    expect(problemsOf({ ...production, DATABASE_URL: "" })).toContain("DATABASE_URL");
  });

  it("rejects a short COOKIE_SECRET in production but not in development", () => {
    expect(problemsOf({ ...production, COOKIE_SECRET: "x".repeat(31) })).toContain(
      "at least 32 characters",
    );
    expect(parseConfig({ COOKIE_SECRET: "short" }).cookieSecret).toBe("short");
  });

  it("uses the unpooled URL for migrations only when set", () => {
    expect(parseConfig(production).databaseUrlUnpooled).toBe(production.DATABASE_URL);
    const direct = "postgres://u:p@db.example.com/app";
    expect(parseConfig({ ...production, DATABASE_URL_UNPOOLED: direct }).databaseUrlUnpooled).toBe(
      direct,
    );
  });

  it("parses TRUST_PROXY strictly", () => {
    expect(parseConfig({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(parseConfig({ TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(parseConfig({ TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(problemsOf({ TRUST_PROXY: "yes" })).toContain("TRUST_PROXY");
    expect(problemsOf({ TRUST_PROXY: "0" })).toContain("TRUST_PROXY");
  });

  it("rejects an invalid PORT or NODE_ENV", () => {
    expect(problemsOf({ PORT: "abc" })).toContain("PORT");
    expect(problemsOf({ PORT: "70000" })).toContain("PORT");
    expect(problemsOf({ NODE_ENV: "staging" })).toContain("NODE_ENV");
  });
});

describe("process start-up", () => {
  it("exits 1 with a readable message when production is missing its secrets", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(new URL("./main.ts", import.meta.url))],
      {
        env: { PATH: process.env.PATH, NODE_ENV: "production" },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("COOKIE_SECRET: required in production");
    expect(result.stderr).toContain("DATABASE_URL: required in production");
  });
});
