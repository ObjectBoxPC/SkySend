import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = 3170;
const BASE_URL = `http://localhost:${PORT}`;
const CI = !!process.env.CI;

/**
 * The tests run against the production build: the server serves the SPA and the API from one
 * origin, the way an instance does. Run `pnpm test:e2e` at the root, which builds first.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  // Each engine takes its own download path, see apps/web/src/lib/download-tiers.ts.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: "node scripts/serve.mjs",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: !CI,
    env: {
      // The browsers talk to the recording proxy, which passes everything on to the server.
      PROXY_PORT: String(PORT),
      PORT: String(PORT + 1),
      HOST: "127.0.0.1",
      BASE_URL,
      DATA_DIR: join(tmpdir(), "skysend-e2e"),
      // Every test comes from the same address, so the limits per address are out of the way.
      RATE_LIMIT_MAX: "100000",
      FILE_UPLOAD_QUOTA_BYTES: "0",
      FILE_REQUEST_DAILY_LIMIT: "10000",
      // A share that ran out says so, instead of vanishing in a sweep halfway through a test.
      CLEANUP_INTERVAL: "86400",
    },
  },
});
