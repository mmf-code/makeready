import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
  use: {
    baseURL: process.env.MAKEREADY_E2E_BASE_URL ?? "http://127.0.0.1:3000",
    // Authentication data must not be recorded in traces, videos, or screenshots.
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
