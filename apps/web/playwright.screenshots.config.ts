import { defineConfig } from "@playwright/test";

// Generates docs/screenshots against a running `pnpm docker:up` stack. See e2e/screenshots.
export default defineConfig({
  testDir: "./e2e/screenshots",
  workers: 1,
  reporter: "list",
  use: { baseURL: process.env.SMOKE_BASE_URL ?? "http://localhost:8080" },
});
