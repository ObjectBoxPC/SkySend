import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(new URL("../../public/download-sw.js", import.meta.url), "utf8");

interface Worker {
  handleDownload(config: object, id: string, done: () => void): Promise<Response>;
}

/** The worker's script in a context of its own, the network answering with `body`. */
function loadWorker(body: Response): Worker {
  const context = createContext({
    self: { addEventListener: () => {} },
    BroadcastChannel: class {
      onmessage = null;
      postMessage() {}
    },
    fetch: async () => body,
    crypto: globalThis.crypto,
    Response,
    Headers,
    ReadableStream,
    TextEncoder,
    URL,
    DOMException,
    console: { debug() {}, warn() {}, error() {} },
    setTimeout,
  });
  runInContext(SOURCE, context);
  return context as unknown as Worker;
}

describe("download-sw.js", () => {
  it("hands over a download that the browser may neither guess nor run", async () => {
    const worker = loadWorker(
      new Response(new Uint8Array(100), { headers: { "Content-Type": "application/octet-stream" } }),
    );
    const response = await worker.handleDownload(
      {
        url: "/api/download/x",
        authToken: "t",
        tokenHeader: "X-Auth-Token",
        secret: new ArrayBuffer(32),
        salt: new ArrayBuffer(16),
        filename: "page.html",
        mimeType: "text/html",
        size: 100,
        plaintextSize: null,
      },
      "id",
      () => {},
    );
    expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
  });
});
