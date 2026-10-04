import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "./health";

describe("healthResponseSchema", () => {
  it("parses a valid health response", () => {
    expect(healthResponseSchema.parse({ status: "ok" })).toEqual({ status: "ok" });
  });

  it("rejects an invalid status", () => {
    expect(() => healthResponseSchema.parse({ status: "down" })).toThrow();
  });

  it("rejects a missing status", () => {
    expect(() => healthResponseSchema.parse({})).toThrow();
  });
});
