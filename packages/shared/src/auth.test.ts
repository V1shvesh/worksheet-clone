import { describe, expect, it } from "vitest";
import { signupSchema } from "./auth.js";

describe("signupSchema", () => {
  it("accepts a valid email and password", () => {
    const result = signupSchema.safeParse({ email: "user@example.com", password: "longenough" });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid email", () => {
    const result = signupSchema.safeParse({ email: "not-an-email", password: "longenough" });
    expect(result.success).toBe(false);
  });

  it("rejects a too-short password", () => {
    const result = signupSchema.safeParse({ email: "user@example.com", password: "short" });
    expect(result.success).toBe(false);
  });
});
