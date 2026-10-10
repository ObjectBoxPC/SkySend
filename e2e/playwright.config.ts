import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import type { TargetOptions } from "./tests/support/fixtures.js";

const CI = !!process.env.CI;
/** Installed by `pnpm test:e2e:install`, see scripts/install-caddy.mjs. */
const CADDY = join(import.meta.dirname, ".tools", "caddy");

type Target = TargetOptions & {
  name: string;
  /** The address the browsers open. */
  origin: string;
  /** The recording proxy of scripts/serve.mjs, with the server one port above it. */
  proxyPort: number;
  caddy?: boolean;
  env?: Record<string, string>;
  testIgnore?: string[];
};

/**
 * The setups the tests run against. Each is a server of its own with its own data directory,
 * behind the recording proxy. The Caddy ones put a reverse proxy with TLS and HTTP/2 in front,
 * set up like docs/user-guide/self-hosting/reverse-proxy.md, see proxies/Caddyfile.
 */
const TARGETS: Target[] = [
  {
    name: "direct",
    origin: "http://localhost:3170",
    proxyPort: 3170,
    protocol: "http/1.1",
    uploadTransport: "ws",
  },
  {
    name: "caddy",
    origin: "https://localhost:3443",
    proxyPort: 3270,
    protocol: "h2",
    uploadTransport: "ws",
    caddy: true,
    env: { TRUST_PROXY: "true" },
  },
  {
    // Chunks over HTTP/2 is where uploads stalled behind proxies before, in v2.2.2 and v2.2.3.
    name: "caddy-chunks",
    origin: "https://localhost:3444",
    proxyPort: 3370,
    protocol: "h2",
    uploadTransport: "http",
    caddy: true,
    env: { TRUST_PROXY: "true", FILE_UPLOAD_WS: "false" },
    // Notes take neither upload transport, and the guard test needs the WebSocket route.
    testIgnore: ["**/notes.spec.ts", "**/guard.spec.ts"],
  },
];

const caddyInstalled = existsSync(CADDY);
if (!caddyInstalled && CI) throw new Error(`Caddy is missing, run pnpm test:e2e:install`);
if (!caddyInstalled && !process.env.TEST_WORKER_INDEX) {
  console.warn(
    "Caddy is not installed, the tests behind it are left out. Run pnpm test:e2e:install.",
  );
}
const targets = TARGETS.filter((target) => !target.caddy || caddyInstalled);
const [caddyWs, caddyChunks] = TARGETS.filter((target) => target.caddy);

// Each engine takes its own download path, see apps/web/src/lib/download-tiers.ts.
const engines = [
  ["chromium", devices["Desktop Chrome"]],
  ["firefox", devices["Desktop Firefox"]],
  ["webkit", devices["Desktop Safari"]],
] as const;

/** Every test comes from the same address, so the limits per address are out of the way. */
const serverEnv = {
  HOST: "127.0.0.1",
  RATE_LIMIT_MAX: "100000",
  FILE_UPLOAD_QUOTA_BYTES: "0",
  FILE_REQUEST_DAILY_LIMIT: "10000",
  // A share that ran out says so, instead of vanishing in a sweep halfway through a test.
  CLEANUP_INTERVAL: "86400",
};

/**
 * The tests run against the production build: the server serves the SPA and the API from one
 * origin, the way an instance does. Run `pnpm test:e2e` at the root, which builds first.
 */
export default defineConfig<TargetOptions>({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 3 : undefined,
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: targets.flatMap((target) =>
    engines.map(([engine, device]) => {
      // Caddy signs with its own CA, which no browser knows.
      const https = target.origin.startsWith("https:");
      return {
        name: target.name === "direct" ? engine : `${engine}-${target.name}`,
        testIgnore: target.testIgnore,
        use: {
          ...device,
          baseURL: target.origin,
          ignoreHTTPSErrors: https,
          // Chromium refuses a Service Worker from an origin with a certificate error unless
          // the whole browser ignores such errors, which a trusted certificate makes moot on a
          // real instance.
          ...(https && engine === "chromium"
            ? { launchOptions: { args: ["--ignore-certificate-errors"] } }
            : {}),
          protocol: target.protocol,
          uploadTransport: target.uploadTransport,
        },
      };
    }),
  ),
  webServer: [
    ...targets.map((target) => ({
      command: "node scripts/serve.mjs",
      url: `http://127.0.0.1:${target.proxyPort}/api/health`,
      reuseExistingServer: !CI,
      env: {
        ...serverEnv,
        ...target.env,
        PROXY_PORT: String(target.proxyPort),
        PORT: String(target.proxyPort + 1),
        BASE_URL: target.origin,
        DATA_DIR: join(tmpdir(), `skysend-e2e-${target.name}`),
      },
    })),
    ...(caddyInstalled && caddyWs && caddyChunks
      ? [
          {
            command: `${CADDY} run --config proxies/Caddyfile --adapter caddyfile`,
            url: `${caddyWs.origin}/api/health`,
            ignoreHTTPSErrors: true,
            reuseExistingServer: !CI,
            env: {
              E2E_CADDY_STORAGE: join(tmpdir(), "skysend-e2e-caddy"),
              E2E_CADDY_WS_PORT: new URL(caddyWs.origin).port,
              E2E_CADDY_WS_UPSTREAM: String(caddyWs.proxyPort),
              E2E_CADDY_CHUNKS_PORT: new URL(caddyChunks.origin).port,
              E2E_CADDY_CHUNKS_UPSTREAM: String(caddyChunks.proxyPort),
            },
          },
        ]
      : []),
  ],
});
