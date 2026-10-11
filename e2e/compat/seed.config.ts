import { defineConfig, devices } from "@playwright/test";

/**
 * Drives the UI of an old release while compat/seed.mjs makes its snapshot. Not part of a
 * normal run, which only ever reads the snapshots.
 */
export default defineConfig({
  testDir: "./seed",
  workers: 1,
  retries: 0,
  timeout: 300_000,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: process.env.SEED_URL,
    locale: "en-US",
  },
});
