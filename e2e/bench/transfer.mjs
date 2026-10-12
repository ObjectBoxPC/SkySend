// Measures one upload and one download of a large file through the real app in a real browser,
// against the built server, and records the speed of every hop over time. Not a test: it fails
// only when the transfer fails or the file comes back different, and prints what it measured.
//
//   browser --> [proxy A] --> server --> [proxy B] --> S3
//
// Proxy A counts what the browser sends to the server and gets back from it. Proxy B counts what
// the server sends to the bucket, and since the presigned download URLs point at it as well, what
// the browser downloads from the bucket. Both are plain TCP relays, so they change nothing on the
// wire. The page records the progress the upload worker reports, which is what the UI shows.
//
// Build first (pnpm test:e2e:build), then for example:
//   node e2e/bench/transfer.mjs --browser firefox --storage s3 --size 2048
// See e2e/bench/README.md for every option.
/* global window -- the recorder and page.evaluate callbacks run in the browser. */
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomFillSync } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import net from "node:net";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium, firefox, webkit } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..", "..");
const WORK = join(ROOT, "e2e", ".large-files", "bench");
const MIB = 1024 * 1024;

const { values: opts } = parseArgs({
  options: {
    browser: { type: "string", default: "chromium" },
    storage: { type: "string", default: "fs" },
    s3: { type: "string", default: "local" },
    transport: { type: "string", default: "ws" },
    size: { type: "string", default: "1024" },
    label: { type: "string" },
    env: { type: "string", multiple: true, default: [] },
    "no-verify": { type: "boolean", default: false },
    "no-download": { type: "boolean", default: false },
    profile: { type: "boolean", default: false },
    port: { type: "string", default: "3900" },
    // "nginx" puts the Nginx of the reverse proxy guide in front, with TLS and HTTP/2, the
    // way an instance runs. The browser then opens https://localhost.
    proxy: { type: "string" },
    // Chromium defaults to the full browser in its new headless mode, which is what people
    // run, not the headless shell the end-to-end tests use. "shell" picks the shell.
    channel: { type: "string" },
    // Several senders upload the same file at once, and nothing is downloaded. Shows what
    // parallel uploads cost the server, in memory above all.
    parallel: { type: "string", default: "1" },
    // Closes the sender this many seconds into the upload, the way a person closes the tab.
    // What it leaves behind shows whether an abandoned upload is cleaned up.
    "cancel-after": { type: "string" },
  },
});

const engines = { chromium, firefox, webkit };
const engine = engines[opts.browser];
if (!engine) throw new Error(`--browser must be one of ${Object.keys(engines).join(", ")}`);
if (!["fs", "s3"].includes(opts.storage)) throw new Error("--storage must be fs or s3");
if (!["ws", "http"].includes(opts.transport)) throw new Error("--transport must be ws or http");

const SIZE = Number(opts.size) * MIB;
const BASE = Number(opts.port);
const PORTS = { proxyA: BASE, server: BASE + 1, proxyB: BASE + 2, s3: BASE + 3 };
if (opts.proxy && opts.proxy !== "nginx") throw new Error("--proxy must be nginx");
const TLS_PORT = BASE + 6;
const ORIGIN = opts.proxy ? `https://localhost:${TLS_PORT}` : `http://127.0.0.1:${PORTS.proxyA}`;
const BUCKET = "skysend-bench";
const label =
  opts.label ??
  `${opts.browser}-${opts.storage}${opts.storage === "s3" ? `-${opts.s3}` : ""}-${opts.transport}-${opts.size}m`;

const cleanups = [];
async function cleanup() {
  while (cleanups.length > 0) await Promise.resolve(cleanups.pop()()).catch(() => {});
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => void cleanup().then(() => process.exit(130)));
}

/** The source file, kept between runs since writing it takes longer than some transfers. */
async function sourceFile(size) {
  mkdirSync(WORK, { recursive: true });
  const path = join(WORK, `source-${size}.bin`);
  const sidecar = `${path}.sha256`;
  if (existsSync(path) && existsSync(sidecar))
    return { path, sha256: readFileSync(sidecar, "utf8") };
  // Random bytes, so no layer can compress them away. Ciphertext is random anyway.
  const hash = createHash("sha256");
  const block = Buffer.alloc(8 * MIB);
  const file = await open(path, "w");
  for (let offset = 0; offset < size; offset += block.length) {
    const bytes = block.subarray(0, Math.min(block.length, size - offset));
    randomFillSync(bytes);
    hash.update(bytes);
    await file.write(bytes);
  }
  await file.close();
  const sha256 = hash.digest("hex");
  writeFileSync(sidecar, sha256);
  return { path, sha256 };
}

async function hashFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: 8 * MIB })) hash.update(chunk);
  return hash.digest("hex");
}

/** A TCP relay that counts the bytes in each direction. */
function countingProxy(listenPort, host, port) {
  const counter = { up: 0, down: 0, connections: 0 };
  const sockets = new Set();
  const server = net.createServer((client) => {
    counter.connections++;
    const upstream = net.connect({ host, port });
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    sockets.add(client).add(upstream);
    client.on("data", (data) => (counter.up += data.length));
    upstream.on("data", (data) => (counter.down += data.length));
    client.pipe(upstream);
    upstream.pipe(client);
    const end = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on("error", end).on("close", end);
    upstream.on("error", end).on("close", end);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => {
      cleanups.push(() => {
        for (const socket of sockets) socket.destroy();
        server.close();
      });
      resolve(counter);
    });
  });
}

async function waitFor(url, what, attempts = 240) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const answer = await fetch(url).catch(() => null);
    if (answer?.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${what} did not come up at ${url}`);
}

/** Starts SeaweedFS on this machine, or points at an existing store, and makes the bucket. */
async function startS3() {
  let target = opts.s3;
  if (opts.s3 === "local") {
    const name = "skysend-bench-s3";
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    const image = (await import("../scripts/images.mjs")).IMAGES.s3;
    execFileSync(
      "docker",
      [
        "run",
        "--detach",
        "--rm",
        "--name",
        name,
        "--publish",
        `127.0.0.1:${PORTS.s3}:8333`,
        image,
        "server",
        "-s3",
        "-master.telemetry=false",
      ],
      { stdio: "ignore" },
    );
    cleanups.push(() => execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }));
    target = `http://127.0.0.1:${PORTS.s3}`;
    await waitFor(target, "SeaweedFS");
  }
  // SeaweedFS without identities takes an unsigned request. An existing bucket answers 409.
  const created = await fetch(`${target}/${BUCKET}`, { method: "PUT" });
  if (!created.ok && created.status !== 409)
    throw new Error(`Creating the bucket failed with ${created.status}`);
  const url = new URL(target);
  return { host: url.hostname, port: Number(url.port || 80) };
}

function startServer(extraEnv) {
  const dataDir = join(WORK, "data");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(PORTS.server),
    BASE_URL: ORIGIN,
    ...(opts.proxy ? { TRUST_PROXY: "true" } : {}),
    DATA_DIR: dataDir,
    FILE_MAX_SIZE: "64GB",
    FILE_UPLOAD_WS: opts.transport === "ws" ? "true" : "false",
    RATE_LIMIT_MAX: "100000",
    FILE_UPLOAD_QUOTA_BYTES: "0",
    CLEANUP_INTERVAL: "86400",
    ...extraEnv,
  };
  for (const pair of opts.env) {
    const at = pair.indexOf("=");
    env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  const args = [];
  if (opts.profile) {
    const profiles = join(WORK, "profiles", label);
    rmSync(profiles, { recursive: true, force: true });
    args.push("--cpu-prof", `--cpu-prof-dir=${profiles}`);
  }
  const child = spawn(
    process.execPath,
    [...args, join(ROOT, "apps", "server", "dist", "index.js")],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const log = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (data) => log.push(...data.toString().split("\n").filter(Boolean)));
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  // SIGTERM lets the server shut down, which also writes the CPU profile.
  cleanups.push(async () => {
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    child.kill("SIGKILL");
  });
  return { child, log, env };
}

const TICKS = 100;
/** CPU seconds a process has used so far, user and system. */
function cpuSeconds(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[11]) + Number(fields[12])) / TICKS;
  } catch {
    return 0;
  }
}
function rssBytes(pid) {
  try {
    const match = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}
/** A process and everything it started, like the renderers and the GPU process of a browser. */
function processTree(root) {
  const children = new Map();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(Number(entry));
    } catch {
      // Gone meanwhile.
    }
  }
  const tree = [];
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.pop();
    tree.push(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return tree;
}

/**
 * The processes of the browser. Playwright starts the browser as a child of this process, beside
 * the server, so it is everything below this process but the server and what the server started.
 */
function browserTree(serverPid) {
  const server = new Set(processTree(serverPid));
  return processTree(process.pid).filter((pid) => pid !== process.pid && !server.has(pid));
}

/** Samples every counter and both processes until stopped. */
function startSampler(counters, serverPid) {
  const samples = [];
  let tree = browserTree(serverPid);
  let treeAge = 0;
  const sample = () => {
    if (++treeAge >= 8) {
      tree = browserTree(serverPid);
      treeAge = 0;
    }
    samples.push({
      t: Date.now(),
      aUp: counters.a.up,
      aDown: counters.a.down,
      bUp: counters.b?.up ?? 0,
      bDown: counters.b?.down ?? 0,
      serverCpu: cpuSeconds(serverPid),
      serverRss: rssBytes(serverPid),
      browserCpu: tree.reduce((sum, pid) => sum + cpuSeconds(pid), 0),
      browserRss: tree.reduce((sum, pid) => sum + rssBytes(pid), 0),
    });
  };
  sample();
  const timer = setInterval(sample, 100);
  return {
    samples,
    stop() {
      clearInterval(timer);
      sample();
    },
  };
}

/** Rates over windows of `windowMs` between `from` and `to`, in MiB/s. */
function rates(samples, key, from, to, windowMs) {
  const inside = samples.filter((s) => s.t >= from && s.t <= to);
  const out = [];
  for (let start = 0; start < inside.length;) {
    let end = start;
    while (end < inside.length - 1 && inside[end].t - inside[start].t < windowMs) end++;
    if (end === start) break;
    const span = (inside[end].t - inside[start].t) / 1000;
    out.push((inside[end][key] - inside[start][key]) / MIB / span);
    start = end;
  }
  return out;
}

function stats(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  const round = (v) => Math.round(v * 10) / 10;
  return {
    mean: round(mean),
    p10: round(at(0.1)),
    p50: round(at(0.5)),
    p90: round(at(0.9)),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
    // Spread relative to the mean, the number behind "the speed goes up and down".
    cv: Math.round((sd / mean) * 100) / 100,
    stalls: values.filter((v) => v < mean * 0.25).length,
  };
}

/** What a phase cost the server and the browser, from the samples between `from` and `to`. */
function cost(samples, from, to) {
  const inside = samples.filter((s) => s.t >= from && s.t <= to);
  if (inside.length < 2) return null;
  const first = inside[0];
  const last = inside.at(-1);
  const seconds = (last.t - first.t) / 1000;
  return {
    serverCpuPercent: Math.round(((last.serverCpu - first.serverCpu) / seconds) * 100),
    browserCpuPercent: Math.round(((last.browserCpu - first.browserCpu) / seconds) * 100),
    serverPeakRssMiB: Math.round(Math.max(...inside.map((s) => s.serverRss)) / MIB),
    browserPeakRssMiB: Math.round(Math.max(...inside.map((s) => s.browserRss)) / MIB),
  };
}

const RECORDER = () => {
  // Wraps Worker so every message the upload worker posts is kept with its time. Only the
  // fields that describe progress are kept, never a whole message, since one carries the secret.
  const log = [];
  Object.defineProperty(window, "__bench", { value: log });
  const Native = window.Worker;
  window.Worker = class extends Native {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (event) => {
        const m = event.data;
        if (!m || typeof m.type !== "string") return;
        if (!["progress", "phase", "transport", "storage"].includes(m.type)) return;
        log.push({
          t: Date.now(),
          type: m.type,
          loaded: m.loaded,
          total: m.total,
          phase: m.phase,
          transport: m.transport,
          backend: m.backend,
        });
      });
    }
  };
};

/** Nginx with the server block of the reverse proxy guide, in Docker, through e2e/scripts. */
async function startNginx() {
  const child = spawn(
    process.execPath,
    [join(ROOT, "e2e", "scripts", "nginx.mjs"), "bench", String(TLS_PORT), String(PORTS.proxyA)],
    { stdio: "ignore" },
  );
  const exited = new Promise((resolve) => child.once("exit", resolve));
  cleanups.push(async () => {
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  });
  const https = await import("node:https");
  for (let attempt = 0; attempt < 240; attempt++) {
    const up = await new Promise((resolve) => {
      https
        .get(`${ORIGIN}/api/health`, { rejectUnauthorized: false }, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        })
        .on("error", () => resolve(false));
    });
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Nginx did not come up");
}

/** Multipart uploads still open in the bench bucket, and how many parts they hold. */
async function bucketLeftovers(store) {
  const s3 = createRequire(join(ROOT, "apps", "server", "package.json"))("@aws-sdk/client-s3");
  const client = new s3.S3Client({
    region: "us-east-1",
    endpoint: `http://${store.host}:${store.port}`,
    forcePathStyle: true,
    credentials: { accessKeyId: "bench", secretAccessKey: "bench" },
  });
  try {
    const listed = await client.send(new s3.ListMultipartUploadsCommand({ Bucket: BUCKET }));
    const uploads = listed.Uploads ?? [];
    let parts = 0;
    for (const upload of uploads) {
      const found = await client.send(
        new s3.ListPartsCommand({ Bucket: BUCKET, Key: upload.Key, UploadId: upload.UploadId }),
      );
      parts += found.Parts?.length ?? 0;
    }
    return { multipartUploads: uploads.length, parts };
  } catch (err) {
    return { error: String(err) };
  } finally {
    client.destroy();
  }
}

/** One upload and, unless --no-download, its download, with every step timed. */
async function singleTransfer(browser, source, result, sampler, counters) {
  // ── Upload ──────────────────────────────────────
  const sender = await browser.newContext({
    locale: "en-US",
    acceptDownloads: true,
    ignoreHTTPSErrors: true,
  });
  await sender.addInitScript(RECORDER);
  const page = await sender.newPage();
  const consoleLines = [];
  page.on("console", (message) => consoleLines.push(message.text()));
  // The reason the browser gives for a request that failed, which fetch() hides behind
  // "Failed to fetch".
  sender.on("requestfailed", (request) =>
    consoleLines.push(
      `requestfailed ${request.method()} ${request.url()} ${request.failure()?.errorText}`,
    ),
  );
  await page.goto(`${ORIGIN}/`);
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(source.path);
  const uploadStart = Date.now();
  await page.getByRole("button", { name: "Encrypt and upload" }).click();
  if (opts["cancel-after"]) {
    await page.waitForTimeout(Number(opts["cancel-after"]) * 1000);
    const events = await page.evaluate(() => window.__bench);
    await sender.close();
    result.upload = {
      cancelledAfterSeconds: Number(opts["cancel-after"]),
      reportedBytes: events.filter((e) => e.type === "progress").at(-1)?.loaded ?? 0,
    };
    return;
  }
  const linkBox = page.getByLabel("Share this link", { exact: true });
  // An upload that fails shows an error toast instead of the link, which would otherwise
  // leave this waiting for an hour.
  const toast = page.locator('[data-sonner-toast][data-type="error"]').first();
  const outcome = await Promise.race([
    linkBox.waitFor({ state: "visible", timeout: 60 * 60_000 }).then(() => "link"),
    toast.waitFor({ state: "visible", timeout: 60 * 60_000 }).then(() => "error"),
  ]);
  if (outcome === "error") {
    result.consoleLines = consoleLines.slice(-30);
    throw new Error(
      `The upload failed: ${await toast.textContent()}\n${consoleLines.slice(-15).join("\n")}`,
    );
  }
  const uploadEnd = Date.now();
  const link = (await linkBox.textContent()) ?? "";
  const events = await page.evaluate(() => window.__bench);
  const closeStart = Date.now();
  await sender.close();
  const closeEnd = Date.now();

  const progress = events.filter((e) => e.type === "progress");
  const lastProgress = progress.at(-1);
  const firstProgress = progress[0];
  result.upload = {
    seconds: (uploadEnd - uploadStart) / 1000,
    mibPerSecond: Math.round((SIZE / MIB / ((uploadEnd - uploadStart) / 1000)) * 10) / 10,
    transport: events.find((e) => e.type === "transport")?.transport,
    // From the click to the first byte the worker reports: keys, the socket, the session.
    startupSeconds: firstProgress ? (firstProgress.t - uploadStart) / 1000 : null,
    // From the last progress report to the link: what the server still did after the UI showed 100 %.
    tailSeconds: lastProgress ? (uploadEnd - lastProgress.t) / 1000 : null,
    progressEvents: progress.length,
  };
  // What the UI shows: the worker's reported bytes, in the same windows.
  const uiSamples = progress.map((e) => ({ t: e.t, ui: e.loaded }));
  result.upload.uiRate1s = stats(rates(uiSamples, "ui", uploadStart, uploadEnd, 1000));
  result.upload.uiRate500ms = stats(rates(uiSamples, "ui", uploadStart, uploadEnd, 500));
  result.upload.wireRate1s = stats(rates(sampler.samples, "aUp", uploadStart, uploadEnd, 1000));
  result.upload.wireRate250ms = stats(rates(sampler.samples, "aUp", uploadStart, uploadEnd, 250));
  if (counters.b)
    result.upload.s3Rate1s = stats(rates(sampler.samples, "bUp", uploadStart, uploadEnd, 1000));
  result.upload.cost = cost(sampler.samples, uploadStart, uploadEnd);
  // The progress the worker reported, as [time, bytes], for timeline.mjs.
  result.upload.progress = progress.map((e) => [e.t, e.loaded]);
  result.upload.wireBytes = { a: counters.a.up, b: counters.b?.up };
  // TCP connections opened so far, to the server and to the bucket.
  result.upload.connections = { a: counters.a.connections, b: counters.b?.connections };

  // ── Download ────────────────────────────────────
  if (!opts["no-download"]) {
    const recipient = await browser.newContext({
      locale: "en-US",
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
    });
    const page2 = await recipient.newPage();
    const tiers = [];
    page2.on("console", (message) => {
      const tier = /Download tier: (\d)/.exec(message.text());
      if (tier) tiers.push(tier[1]);
    });
    const openStart = Date.now();
    await page2.goto(link);
    const loaded = Date.now();
    const button = page2.getByRole("button", { name: "Download", exact: true });
    await button.waitFor({ state: "visible" });
    const visible = Date.now();
    const downloadStart = Date.now();
    const started = page2.waitForEvent("download", { timeout: 10 * 60_000 });
    await button.click();
    // WebKit is Safari to the app, which warns before a download over 256 MiB.
    const anyway = page2.getByRole("button", { name: "Download anyway" });
    const warned = await Promise.race([
      started.then(() => false),
      anyway.waitFor({ timeout: 10 * 60_000 }).then(() => true),
    ]);
    if (warned) await anyway.click();
    const download = await started;
    const path = await download.path();
    const downloadEnd = Date.now();
    const key = opts.storage === "s3" ? "bDown" : "aDown";
    result.download = {
      seconds: (downloadEnd - downloadStart) / 1000,
      mibPerSecond: Math.round((SIZE / MIB / ((downloadEnd - downloadStart) / 1000)) * 10) / 10,
      // Closing the sender, loading the link and the Download button showing up.
      steps: {
        closeSender: (closeEnd - closeStart) / 1000,
        loadPage: (loaded - openStart) / 1000,
        buttonVisible: (visible - loaded) / 1000,
      },
      tiers,
      wireRate1s: stats(rates(sampler.samples, key, downloadStart, downloadEnd, 1000)),
      cost: cost(sampler.samples, downloadStart, downloadEnd),
    };
    if (!opts["no-verify"]) {
      result.download.intact = (await hashFile(path)) === source.sha256;
    }
    await download.delete();
    await recipient.close();
  }
}

/** Uploads the file from `count` senders at once and records time and cost of all of them. */
async function parallelUploads(browser, source, count, result, sampler) {
  const start = Date.now();
  const ends = await Promise.all(
    Array.from({ length: count }, async () => {
      const context = await browser.newContext({ locale: "en-US", ignoreHTTPSErrors: true });
      const page = await context.newPage();
      await page.goto(`${ORIGIN}/`);
      await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(source.path);
      await page.getByRole("button", { name: "Encrypt and upload" }).click();
      const toast = page.locator('[data-sonner-toast][data-type="error"]').first();
      const outcome = await Promise.race([
        page
          .getByLabel("Share this link", { exact: true })
          .waitFor({ timeout: 60 * 60_000 })
          .then(() => "link"),
        toast.waitFor({ timeout: 60 * 60_000 }).then(() => "error"),
      ]);
      if (outcome === "error") throw new Error(`An upload failed: ${await toast.textContent()}`);
      const end = Date.now();
      await context.close();
      return end;
    }),
  );
  const end = Math.max(...ends);
  result.parallel = {
    count,
    seconds: (end - start) / 1000,
    totalMibPerSecond: Math.round(((count * SIZE) / MIB / ((end - start) / 1000)) * 10) / 10,
    wireRate1s: stats(rates(sampler.samples, "aUp", start, end, 1000)),
    cost: cost(sampler.samples, start, end),
  };
}

async function main() {
  const source = await sourceFile(SIZE);
  const counters = { a: null, b: null };
  let storageEnv = {};
  let store = null;
  if (opts.storage === "s3") {
    store = await startS3();
    counters.b = await countingProxy(PORTS.proxyB, store.host, store.port);
    storageEnv = {
      STORAGE_BACKEND: "s3",
      S3_BUCKET: BUCKET,
      S3_REGION: "us-east-1",
      S3_ENDPOINT: `http://127.0.0.1:${PORTS.proxyB}`,
      S3_ACCESS_KEY: "bench",
      S3_SECRET_KEY: "bench",
      S3_FORCE_PATH_STYLE: "true",
    };
  }
  const server = startServer(storageEnv);
  serverForErrors = server;
  counters.a = await countingProxy(PORTS.proxyA, "127.0.0.1", PORTS.server);
  await waitFor(`http://127.0.0.1:${PORTS.server}/api/health`, "The server");
  if (opts.proxy) await startNginx();

  const downloads = join(WORK, "downloads");
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });
  cleanups.push(() => rmSync(downloads, { recursive: true, force: true }));
  const channel = opts.channel ?? (opts.browser === "chromium" ? "chromium" : undefined);
  const browser = await engine.launch({
    downloadsPath: downloads,
    // Chromium refuses a Service Worker from an origin with a certificate error unless the
    // whole browser ignores such errors, see e2e/CLAUDE.md.
    ...(opts.proxy && opts.browser === "chromium" ? { args: ["--ignore-certificate-errors"] } : {}),
    ...(channel && channel !== "shell" ? { channel } : {}),
  });
  cleanups.push(() => browser.close());
  const sampler = startSampler(counters, server.child.pid);

  const result = {
    label,
    browser: opts.browser,
    channel,
    version: browser.version(),
    storage: opts.storage,
    s3: opts.storage === "s3" ? opts.s3 : undefined,
    transport: opts.transport,
    sizeMiB: SIZE / MIB,
    env: opts.env,
    startedAt: new Date().toISOString(),
  };
  try {
    if (Number(opts.parallel) > 1)
      await parallelUploads(browser, source, Number(opts.parallel), result, sampler);
    else await singleTransfer(browser, source, result, sampler, counters);
  } finally {
    sampler.stop();
    result.samples = sampler.samples;
    result.serverLog = server.log.filter((line) => !/^<--|^-->/.test(line)).slice(-50);
    await browser.close().catch(() => {});
    if (store) {
      // What a run leaves in the bucket. A multipart upload that was never completed or
      // aborted keeps its parts, which a provider bills until a lifecycle rule removes them.
      // Aborts run after the socket closed, so they get a moment first.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      result.s3Leftovers = await bucketLeftovers(store);
      console.log(`[bench] left in the bucket: ${JSON.stringify(result.s3Leftovers)}`);
    }
    await cleanup();
  }

  const resultsDir = join(WORK, "results");
  mkdirSync(resultsDir, { recursive: true });
  const file = join(resultsDir, `${label}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  const { samples: _samples, serverLog, ...summary } = result;
  if (summary.upload) summary.upload = { ...summary.upload, progress: undefined };
  console.log(JSON.stringify(summary, null, 2));
  if (serverLog.some((line) => /error|failed/i.test(line)))
    console.log("server log:\n" + serverLog.join("\n"));
  console.log(`[bench] ${file}`);
  if (result.download && result.download.intact === false) {
    console.error("[bench] The download differs from the upload");
    process.exitCode = 1;
  }
}

let serverForErrors = null;
main().catch(async (err) => {
  console.error(err);
  if (serverForErrors) console.error("server log:\n" + serverForErrors.log.slice(-40).join("\n"));
  await cleanup();
  process.exit(1);
});
