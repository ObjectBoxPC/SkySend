// Measures the stages of the browser's upload pipeline one by one, in a Web Worker like the app's:
// reading the file, encrypting it with the real createEncryptStream of @skysend/crypto, raw
// AES-GCM with one and with several records in flight, and sending over a WebSocket to a sink
// that throws the bytes away. The stage that is slowest alone is the one that caps the upload.
//
//   node e2e/bench/pipeline.mjs [--browser chromium] [--size 1024] [--only read,encrypt,...]
//
// Build @skysend/crypto first. The page has an origin of its own, without the app's CSP, so the
// worker can reach the sink.
/* global window, document, Worker -- page.evaluate runs these callbacks in the browser. */
import { createRequire } from "node:module";
import { createReadStream, existsSync, mkdtempSync } from "node:fs";
import http from "node:http";
import { join, normalize } from "node:path";
import { parseArgs } from "node:util";
import { chromium, firefox, webkit } from "@playwright/test";

const ROOT = join(import.meta.dirname, "..", "..");
const WORK = join(ROOT, "e2e", ".large-files", "bench");
const CRYPTO = join(ROOT, "packages", "crypto", "dist");
const requireServer = createRequire(join(ROOT, "apps", "server", "package.json"));
const { WebSocketServer } = createRequire(requireServer.resolve("@hono/node-ws"))("ws");

const { values: opts } = parseArgs({
  options: {
    browser: { type: "string", default: "chromium" },
    size: { type: "string", default: "1024" },
    only: { type: "string" },
    port: { type: "string", default: "3930" },
    // Registers a Service Worker like the app's download-sw.js before the experiments.
    sw: { type: "boolean", default: false },
    // Gives that Service Worker static routes that send everything else to the network.
    routes: { type: "boolean", default: false },
    persistent: { type: "boolean", default: false },
  },
});
const PORT = Number(opts.port);
const SIZE = Number(opts.size) * 1024 * 1024;
const source = join(WORK, `source-${SIZE}.bin`);
if (!existsSync(source))
  throw new Error(`Run transfer.mjs with --size ${opts.size} first, it writes ${source}`);

const PAGE = `<!doctype html><meta charset="utf-8"><input type="file" id="file">`;

// The worker runs one experiment per message and answers with what it measured.
const WORKER = String.raw`
import { createEncryptStream, deriveKeys, generateSecret, generateSalt } from "/crypto/index.js";
const MIB = 1024 * 1024;

async function fileKey() {
  return (await deriveKeys(generateSecret(), generateSalt())).fileKey;
}

/** Drains a stream and reports throughput and the sizes of the chunks it handed out. */
async function drain(stream, size) {
  const reader = stream.getReader();
  const start = performance.now();
  let bytes = 0, chunks = 0, min = Infinity, max = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength; chunks++;
    min = Math.min(min, value.byteLength); max = Math.max(max, value.byteLength);
  }
  const seconds = (performance.now() - start) / 1000;
  return { mibPerSecond: +(size / MIB / seconds).toFixed(1), bytes, chunks, avgChunk: Math.round(bytes / chunks), min, max };
}

/** AES-GCM over records of 64 KiB, with up to "inFlight" records being encrypted at once. */
async function rawEncrypt(size, inFlight) {
  const key = await fileKey();
  const record = new Uint8Array(65536);
  crypto.getRandomValues(record.subarray(0, 65536));
  const records = Math.ceil(size / 65536);
  const start = performance.now();
  const queue = [];
  for (let i = 0; i < records; i++) {
    const iv = new Uint8Array(12); new DataView(iv.buffer).setUint32(8, i);
    queue.push(crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, record));
    if (queue.length >= inFlight) await queue.shift();
  }
  await Promise.all(queue);
  const seconds = (performance.now() - start) / 1000;
  return { mibPerSecond: +(size / MIB / seconds).toFixed(1), inFlight };
}

/** The send loop of uploadViaWebSocket in upload-worker.ts, with its constants as parameters. */
async function wsSend(stream, size, { frame, high, low, poll, url }) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const reader = stream.getReader();
  let loaded = 0, carry = null, posts = 0, drains = 0, drainMs = 0;
  const start = performance.now();
  const drain = async () => {
    drains++;
    const t = performance.now();
    while (ws.bufferedAmount > low) await new Promise((r) => setTimeout(r, poll));
    drainMs += performance.now() - t;
  };
  const sendFrame = async (f) => {
    if (ws.bufferedAmount > high) await drain();
    const copy = new Uint8Array(f.byteLength); copy.set(f);
    ws.send(copy.buffer);
    loaded += f.byteLength;
    posts++;
    self.postMessage({ type: "progress", loaded, total: size });
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let buf;
    if (carry && carry.byteLength > 0) {
      buf = new Uint8Array(carry.byteLength + value.byteLength); buf.set(carry); buf.set(value, carry.byteLength); carry = null;
    } else buf = value;
    let offset = 0;
    while (buf.byteLength - offset >= frame) { await sendFrame(buf.subarray(offset, offset + frame)); offset += frame; }
    if (offset < buf.byteLength) carry = buf.slice(offset);
  }
  if (carry && carry.byteLength > 0) await sendFrame(carry);
  const sent = performance.now();
  // The sink answers with its byte count once the last byte arrived.
  await new Promise((resolve) => { ws.onmessage = resolve; ws.send("done"); });
  const end = performance.now();
  ws.close();
  return {
    mibPerSecond: +(size / MIB / ((end - start) / 1000)).toFixed(1),
    sendSeconds: +((sent - start) / 1000).toFixed(2),
    flushSeconds: +((end - sent) / 1000).toFixed(2),
    drains, drainMs: Math.round(drainMs), progressPosts: posts,
  };
}

/**
 * POSTs "total" bytes as chunks of 10 MiB, three in flight, like uploadViaHttpChunks, with
 * each body a Blob as the app builds it or a plain Uint8Array.
 */
async function posts(total, { body, chunk = 10 * MIB, inFlight = 3 }) {
  const piece = new Uint8Array(65552);
  crypto.getRandomValues(piece.subarray(0, 65536));
  const active = [];
  let sent = 0, index = 0;
  const start = performance.now();
  while (sent < total) {
    const parts = [];
    let size = 0;
    while (size < chunk) { parts.push(piece.slice()); size += piece.byteLength; }
    let data;
    if (body === "blob") data = new Blob(parts);
    else {
      data = new Uint8Array(size); let o = 0; for (const p of parts) { data.set(p, o); o += p.byteLength; }
      if (body === "arraybuffer") data = data.buffer;
      if (body === "blob-one") data = new Blob([data]);
    }
    const at = index++;
    const p = fetch("/post", { method: "POST", body: data }).then((r) => r.text()).catch((e) => { throw new Error("chunk " + at + " after " + sent + " bytes: " + e); });
    active.push(p);
    sent += size;
    if (active.length >= inFlight) await active.shift();
  }
  await Promise.all(active);
  return { mibPerSecond: +(total / MIB / ((performance.now() - start) / 1000)).toFixed(1), chunks: index };
}

/** The chunk loop of uploadViaHttpChunks in upload-worker.ts, posting to the sink. */
async function postStream(stream, size, { inFlight = 3, chunk = 10 * MIB, settle = 0 }) {
  const reader = stream.getReader();
  let parts = [], chunkSize = 0, index = 0, sent = 0;
  const active = [];
  const start = performance.now();
  const send = (blob, at, bytes) => {
    const p = fetch("/post", { method: "POST", body: blob })
      .then((r) => r.text())
      .catch((e) => { throw new Error("chunk " + at + " after " + sent + " bytes: " + e); })
      .finally(() => active.splice(active.indexOf(p), 1));
    active.push(p);
    sent += bytes;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); chunkSize += value.byteLength;
    if (chunkSize >= chunk) {
      send(new Blob(parts), index++, chunkSize);
      parts = []; chunkSize = 0;
      if (active.length >= inFlight) await Promise.race(active);
      if (settle) await new Promise((r) => setTimeout(r, settle));
    }
  }
  if (chunkSize > 0) send(new Blob(parts), index++, chunkSize);
  await Promise.all(active);
  return { mibPerSecond: +(size / MIB / ((performance.now() - start) / 1000)).toFixed(1), chunks: index };
}

self.onmessage = async ({ data: { name, file, params } }) => {
  try {
    let result;
    if (name === "read") result = await drain(file.stream(), file.size);
    else if (name === "encrypt") result = await drain(file.stream().pipeThrough(createEncryptStream(await fileKey())), file.size);
    else if (name === "raw") result = await rawEncrypt(file.size, params.inFlight);
    else if (name === "ws-plain") result = await wsSend(file.stream(), file.size, params);
    else if (name === "post-encrypt") result = await postStream(file.stream().pipeThrough(createEncryptStream(await fileKey())), file.size, params);
    else if (name === "post-plain") result = await postStream(file.stream(), file.size, params);
    else if (name === "post") result = await posts(params.total, params);
    else if (name === "ws-encrypt") result = await wsSend(file.stream().pipeThrough(createEncryptStream(await fileKey())), file.size, params);
    self.postMessage({ type: "result", result });
  } catch (err) {
    self.postMessage({ type: "result", result: { error: String(err) } });
  }
};
`;

const server = http.createServer((req, res) => {
  const path = new URL(req.url, "http://x").pathname;
  if (path === "/") return res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  if (path === "/post") {
    req.on("data", () => {});
    req.on("end", () => res.writeHead(200).end("ok"));
    return;
  }
  // A Service Worker shaped like download-sw.js: its fetch handler looks at every request of
  // the pages and workers it controls and lets all but its own prefix through.
  if (path === "/sw.js") {
    const routes = opts.routes
      ? `self.addEventListener("install", (e) => {
  if (e.addRoutes) e.addRoutes({ condition: { not: { urlPattern: new URLPattern({ pathname: "/__skysend_download__/*" }) } }, source: "network" });
});`
      : "";
    const sw = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
${routes}
let fetches = 0;
self.addEventListener("message", (e) => e.source.postMessage({ fetches }));
self.addEventListener("fetch", (event) => {
  fetches++;
  if (!new URL(event.request.url).pathname.startsWith("/__skysend_download__/")) return;
});`;
    return res.writeHead(200, { "content-type": "text/javascript" }).end(sw);
  }
  if (path === "/worker.js")
    return res.writeHead(200, { "content-type": "text/javascript" }).end(WORKER);
  if (path.startsWith("/crypto/")) {
    const file = normalize(join(CRYPTO, path.slice("/crypto/".length)));
    if (file.startsWith(CRYPTO) && existsSync(file)) {
      res.writeHead(200, { "content-type": "text/javascript" });
      return createReadStream(file).pipe(res);
    }
  }
  res.writeHead(404).end();
});
// The sink counts what arrives and answers "done" with the count.
const wss = new WebSocketServer({ server, path: "/sink", maxPayload: 1024 * 1024 });
wss.on("connection", (socket) => {
  let bytes = 0;
  socket.on("message", (data, binary) => {
    if (binary) bytes += data.length;
    else socket.send(String(bytes));
  });
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

const engine = { chromium, firefox, webkit }[opts.browser];
// A persistent context is a normal profile with a disk, like a person's browser. The default
// context of launch() is an incognito one, which keeps blobs in memory only.
const launchOptions = opts.browser === "chromium" ? { channel: "chromium" } : {};
let browser;
let page;
if (opts.persistent) {
  const profile = mkdtempSync(join(WORK, "profile-"));
  const context = await engine.launchPersistentContext(profile, launchOptions);
  browser = {
    version: () => context.browser()?.version() ?? "persistent",
    close: () => context.close(),
  };
  page = context.pages()[0] ?? (await context.newPage());
} else {
  browser = await engine.launch(launchOptions);
  page = await browser.newPage();
}
page
  .context()
  .on("requestfailed", (request) =>
    console.log(
      `requestfailed ${request.method()} ${request.url()} ${request.failure()?.errorText}`,
    ),
  );
await page.goto(`http://127.0.0.1:${PORT}/`);
if (opts.sw) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  console.log(
    "controlled by a Service Worker:",
    await page.evaluate(() => !!navigator.serviceWorker.controller),
  );
}
await page.locator("#file").setInputFiles(source);
await page.evaluate(() => {
  window.benchWorker = new Worker("/worker.js", { type: "module" });
});

async function experiment(name, params = {}) {
  return page.evaluate(
    ({ name, params }) =>
      new Promise((resolve) => {
        const file = document.getElementById("file").files[0];
        window.benchWorker.onmessage = ({ data }) => {
          if (data.type === "result") resolve(data.result);
        };
        window.benchWorker.postMessage({ name, file, params });
      }),
    { name, params },
  );
}

const url = `ws://127.0.0.1:${PORT}/sink`;
const CURRENT = { frame: 256 * 1024, high: 8 * 1024 * 1024, low: 2 * 1024 * 1024, poll: 20, url };
const plan = [
  ["read", {}],
  ["encrypt", {}],
  ["raw", { inFlight: 1 }],
  ["raw", { inFlight: 4 }],
  ["raw", { inFlight: 16 }],
  ["ws-plain", CURRENT],
  ["ws-plain", { ...CURRENT, poll: 1 }],
  ["ws-plain", { ...CURRENT, high: 32 * 1024 * 1024, low: 16 * 1024 * 1024 }],
  ["ws-plain", { ...CURRENT, frame: 1024 * 1024 - 64 }],
  ["ws-encrypt", CURRENT],
  ["post-plain", {}],
  ["post-encrypt", {}],
  ["post", { body: "blob", total: 3 * 1024 * 1024 * 1024 }],
  ["post", { body: "buffer", total: 1024 * 1024 * 1024 }],
  ["post", { body: "arraybuffer", total: 1024 * 1024 * 1024 }],
  ["post", { body: "blob-one", total: 3 * 1024 * 1024 * 1024 }],
];
const only = opts.only?.split(",");
console.log(`${opts.browser} ${browser.version()}, ${opts.size} MiB`);
async function swFetches() {
  if (!opts.sw) return null;
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        navigator.serviceWorker.addEventListener("message", (e) => resolve(e.data.fetches), {
          once: true,
        });
        navigator.serviceWorker.controller.postMessage("count");
      }),
  );
}
for (const [name, params] of plan) {
  if (only && !only.includes(name)) continue;
  const { url: _url, ...shown } = params;
  const result = await experiment(name, params);
  console.log(
    name.padEnd(11),
    JSON.stringify(shown),
    JSON.stringify(result),
    opts.sw ? `sw fetch events ${await swFetches()}` : "",
  );
}
await browser.close();
server.close();
process.exit(0);
