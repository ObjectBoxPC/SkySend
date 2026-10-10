// Starts the built server on an empty data directory for the end-to-end tests, behind a proxy
// that records everything the browsers send. Playwright runs it through `webServer` in
// playwright.config.ts, which passes the configuration as environment variables. Build the
// server and the SPA first.
//
// The recording is what the zero-knowledge check of every test searches. It sits in front of
// the server because Playwright does not see all traffic: no Service Worker requests in Firefox,
// no WebSocket frames in WebKit. What reaches this proxy is what reaches the server.
import { mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";

const dataDir = process.env.DATA_DIR;
const proxyPort = Number(process.env.PROXY_PORT);
const serverPort = Number(process.env.PORT);
if (!dataDir || !proxyPort || !serverPort)
  throw new Error("DATA_DIR, PROXY_PORT and PORT are required");

rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

await import("../../apps/server/dist/index.js");

/** What reached the server: a label to name it and the bytes that were sent. */
const recorded = [];
/** A runaway test should fail loudly instead of filling the memory of the machine. */
const MAX_RECORDED_BYTES = 1024 ** 3;
let recordedBytes = 0;

function record(label, bytes) {
  recordedBytes += bytes.length;
  if (recordedBytes > MAX_RECORDED_BYTES) throw new Error("The e2e proxy recorded more than 1 GiB");
  recorded.push({ label, bytes });
}

/** The request line and the headers, as the server gets them. */
function head(req, skip = new Set()) {
  let text = `${req.method} ${req.url} HTTP/1.1\r\n`;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (skip.has(req.rawHeaders[i].toLowerCase())) continue;
    text += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
  }
  return `${text}\r\n`;
}

/** Answers a search of the recording: which of the needles were sent, and where. */
function scan(req, res) {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const { needles } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const hits = [];
    for (const { name, base64 } of needles) {
      const needle = Buffer.from(base64, "base64");
      for (const { label, bytes } of recorded) {
        if (bytes.includes(needle)) hits.push({ name, where: label });
      }
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ hits }));
  });
}

/**
 * Unmasks the frames a client sends over a WebSocket and records each message. Client frames
 * are always masked, so the raw bytes would hide what they carry.
 */
function frameRecorder(label) {
  let pending = Buffer.alloc(0);
  let message = [];
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      if (pending.length < 2) return;
      const fin = (pending[0] & 0x80) !== 0;
      const masked = (pending[1] & 0x80) !== 0;
      let length = pending[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        length = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      const mask = masked ? pending.subarray(offset, offset + 4) : null;
      if (masked) offset += 4;
      if (pending.length < offset + length) return;
      const payload = Buffer.from(pending.subarray(offset, offset + length));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      pending = pending.subarray(offset + length);
      message.push(payload);
      if (fin) {
        record(`${label} frame`, Buffer.concat(message));
        message = [];
      }
    }
  };
}

const proxy = http.createServer((req, res) => {
  if (req.url === "/__e2e__/scan" && req.method === "POST") return scan(req, res);

  const label = `${req.method} ${req.url}`;
  const body = [];
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: serverPort,
      method: req.method,
      path: req.url,
      headers: req.headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode, upstreamRes.statusMessage, upstreamRes.rawHeaders);
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.on("data", (chunk) => body.push(chunk));
  req.on("end", () => {
    record(label, Buffer.from(head(req)));
    if (body.length > 0) record(`${label} body`, Buffer.concat(body));
  });
  req.pipe(upstream);
});

proxy.on("upgrade", (req, socket, firstBytes) => {
  const label = `WS ${req.url}`;
  // Without the offer of compression the frames stay readable for the recording.
  const handshake = head(req, new Set(["sec-websocket-extensions"]));
  record(label, Buffer.from(handshake));
  const recordFrames = frameRecorder(label);
  const upstream = net.connect(serverPort, "127.0.0.1", () => {
    upstream.write(handshake);
    if (firstBytes.length > 0) {
      recordFrames(firstBytes);
      upstream.write(firstBytes);
    }
    socket.on("data", recordFrames);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  const close = () => {
    socket.destroy();
    upstream.destroy();
  };
  socket.on("error", close);
  upstream.on("error", close);
});

// The timeouts of apps/server/src/index.ts, so the proxy in front meets the same server it would
// meet without this one. Node's 5 second keep-alive would let Caddy or Nginx reuse a connection
// just as it closes, the failure v2.11.3 fixed in the server.
proxy.headersTimeout = 60_000;
proxy.requestTimeout = 0;
proxy.keepAliveTimeout = 120_000;

proxy.listen(proxyPort, process.env.HOST, () => {
  console.log(`[e2e] Recording proxy on ${process.env.BASE_URL}`);
});
