import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  // Pre-bundle the harness's deps up front; otherwise Vite discovers them mid-test and reloads.
  optimizeDeps: { entries: ["index.html", "e2e/harness/*.html"] },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/collab": { target: "ws://localhost:3000", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
