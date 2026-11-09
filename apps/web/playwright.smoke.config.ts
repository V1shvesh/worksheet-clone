import { defineConfig } from "@playwright/test";

// Smoke tests against a RUNNING production-like stack (`pnpm docker:up`, then
// `pnpm test:smoke`). Separate from the hermetic suite: no web servers are started,
// and nothing here mocks the backend. Point it elsewhere with SMOKE_BASE_URL.
export default defineConfig({
  testDir: "./e2e/smoke",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: { baseURL: process.env.SMOKE_BASE_URL ?? "http://localhost:8080" },
});
