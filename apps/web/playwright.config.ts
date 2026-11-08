import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  projects: [
    {
      name: "hermetic",
      testIgnore: "**/contract/**",
      use: { baseURL: "http://localhost:4173" },
    },
    {
      // The GridView port contract against the real AG Grid adapter, served by the Vite dev
      // server so the test-only harness page never reaches the production build.
      name: "ag-grid-contract",
      testMatch: "contract/**/*.spec.ts",
      use: { baseURL: "http://localhost:5174" },
    },
  ],
  webServer: [
    {
      command: "pnpm preview --port 4173",
      url: "http://localhost:4173",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm exec vite --port 5174 --strictPort",
      url: "http://localhost:5174",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
