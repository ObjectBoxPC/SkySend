import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { SNAPSHOTS, snapshotVersions } from "./tests/support/compat.js";
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
  /** The reverse proxy in front, which serves the origin with TLS and HTTP/2. */
  proxy?: "caddy" | "nginx";
  /** A release whose snapshot the server starts on, which only compat.spec.ts tests. */
  snapshot?: string;
  env?: Record<string, string>;
  testIgnore?: string[];
};

// Notes take neither upload transport and run behind one proxy only, and the guard test needs
// the WebSocket route, which a server without FILE_UPLOAD_WS does not have.
const NOTES = "**/notes.spec.ts";
const GUARD = "**/guard.spec.ts";
const COMPAT = "**/compat.spec.ts";

/**
 * The setups the tests run against. Each is a server of its own with its own data directory,
 * behind the recording proxy. The others put a reverse proxy with TLS and HTTP/2 in front, set
 * up like docs/user-guide/self-hosting/reverse-proxy.md: Caddy through proxies/Caddyfile, Nginx
 * with the example read straight out of that page by scripts/nginx.mjs.
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
    proxy: "caddy",
    env: { TRUST_PROXY: "true" },
  },
  {
    // Chunks over HTTP/2 is where uploads stalled behind proxies before, in v2.2.2 and v2.2.3.
    name: "caddy-chunks",
    origin: "https://localhost:3444",
    proxyPort: 3370,
    protocol: "h2",
    uploadTransport: "http",
    proxy: "caddy",
    env: { TRUST_PROXY: "true", FILE_UPLOAD_WS: "false" },
    testIgnore: [NOTES, GUARD],
  },
  {
    name: "nginx",
    origin: "https://localhost:3445",
    proxyPort: 3470,
    protocol: "h2",
    uploadTransport: "ws",
    proxy: "nginx",
    env: { TRUST_PROXY: "true" },
    testIgnore: [NOTES],
  },
  {
    name: "nginx-chunks",
    origin: "https://localhost:3446",
    proxyPort: 3570,
    protocol: "h2",
    uploadTransport: "http",
    proxy: "nginx",
    env: { TRUST_PROXY: "true", FILE_UPLOAD_WS: "false" },
    testIgnore: [NOTES, GUARD],
  },
  // One server per released version with a snapshot, which opens the links of that version.
  ...snapshotVersions().map((version, index): Target => ({
    name: `compat-${version}`,
    origin: `http://localhost:${3670 + index * 100}`,
    proxyPort: 3670 + index * 100,
    protocol: "http/1.1",
    uploadTransport: "ws",
    snapshot: version,
    env: { SNAPSHOT: join(SNAPSHOTS, version, "data.tar.gz") },
  })),
];

/** Whether the tools a reverse proxy needs are there, and how to get them if not. */
const proxies = {
  caddy: { ready: existsSync(CADDY), missing: "Caddy is not installed, run pnpm test:e2e:install" },
  // The Nginx image runs on the host network, which Docker Desktop on a Mac has to allow first.
  nginx: {
    ready: spawnSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 }).status === 0,
    missing: "Docker is not available, the Nginx image cannot run",
  },
};
for (const { ready, missing } of Object.values(proxies)) {
  if (ready) continue;
  if (CI) throw new Error(missing);
  if (!process.env.TEST_WORKER_INDEX) console.warn(`${missing}. The tests behind it are left out.`);
}
const targets = TARGETS.filter((target) => !target.proxy || proxies[target.proxy].ready);
const behind = (proxy: Target["proxy"]) => targets.filter((target) => target.proxy === proxy);
const [caddyWs, caddyChunks] = behind("caddy");

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
        // A snapshot server runs the tests of its own release and nothing else.
        ...(target.snapshot
          ? {
              testMatch: COMPAT,
              grep: new RegExp(`\\[${target.snapshot.replaceAll(".", "\\.")}\\]`),
            }
          : { testIgnore: [...(target.testIgnore ?? []), COMPAT] }),
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
    // The proxies start after the servers, whose health they answer for.
    ...(caddyWs && caddyChunks
      ? [
          {
            command: `${CADDY} run --config proxies/Caddyfile --adapter caddyfile`,
            url: `${caddyWs.origin}/api/health`,
            ignoreHTTPSErrors: true,
            reuseExistingServer: !CI,
            env: {
              E2E_CADDY_STORAGE: join(tmpdir(), "skysend-e2e-proxy-caddy"),
              E2E_CADDY_WS_PORT: new URL(caddyWs.origin).port,
              E2E_CADDY_WS_UPSTREAM: String(caddyWs.proxyPort),
              E2E_CADDY_CHUNKS_PORT: new URL(caddyChunks.origin).port,
              E2E_CADDY_CHUNKS_UPSTREAM: String(caddyChunks.proxyPort),
            },
          },
        ]
      : []),
    ...behind("nginx").map((target) => ({
      command: `node scripts/nginx.mjs ${target.name} ${new URL(target.origin).port} ${target.proxyPort}`,
      url: `${target.origin}/api/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !CI,
      // The first start pulls the image.
      timeout: 180_000,
      // Playwright kills a web server outright unless told otherwise, and the container would
      // outlive the killed script. SIGTERM lets the script remove it.
      gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10_000 },
    })),
  ],
});
