import {
  test as base,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { decodeInboxFragment, decodeUploadFragment } from "@skysend/crypto";

type Needle = { name: string; bytes: Buffer };

/** The fragment of a link, which holds its key. */
function fragmentOf(link: string) {
  const fragment = new URL(link).hash.slice(1);
  expect(fragment, "the link carries a key in its fragment").not.toBe("");
  return fragment;
}

/** Searches what reached the server for the needles and returns where each one was found. */
export async function scanServer(request: APIRequestContext, needles: Needle[]) {
  const response = await request.post("/__e2e__/scan", {
    data: {
      needles: needles.map(({ name, bytes }) => ({ name, base64: bytes.toString("base64") })),
    },
  });
  expect(response.ok(), "the recording proxy answers").toBe(true);
  const { hits } = (await response.json()) as { hits: Array<{ name: string; where: string }> };
  return hits;
}

/**
 * What must never reach the server. A test adds what it shares, and after the test the
 * recording of the proxy in scripts/serve.mjs is searched for every one of them.
 */
export class Guard {
  readonly needles: Needle[] = [];

  /** A secret in every encoding a leak could take. */
  secret(name: string, raw: Uint8Array) {
    const bytes = Buffer.from(raw);
    this.needles.push(
      { name: `${name} (base64url)`, bytes: Buffer.from(bytes.toString("base64url")) },
      { name: `${name} (base64)`, bytes: Buffer.from(bytes.toString("base64")) },
      { name: `${name} (hex)`, bytes: Buffer.from(bytes.toString("hex")) },
      { name: `${name} (bytes)`, bytes },
    );
  }

  /** The key in the fragment of a link. */
  secretOf(link: string) {
    this.secret("key", Buffer.from(fragmentOf(link), "base64url"));
  }

  /**
   * The two links of a file request: the whole fragments, and on their own the secrets inside
   * them, which a leak could carry without the rest. The public key of the upload link is no
   * secret and stays out.
   */
  async requestLinks(uploadLink: string, inboxLink: string) {
    const upload = fragmentOf(uploadLink);
    const inbox = fragmentOf(inboxLink);
    this.secret("upload link fragment", Buffer.from(upload, "base64url"));
    this.secret("inbox link fragment", Buffer.from(inbox, "base64url"));
    this.secret("link secret", (await decodeUploadFragment(upload)).linkSecret);
    this.secret("inbox secret", decodeInboxFragment(inbox).secret);
  }

  /** Text that only the sender and the recipient may read, like a filename or a password. */
  text(...values: string[]) {
    for (const value of values) {
      this.needles.push({ name: `"${value}"`, bytes: Buffer.from(value) });
    }
  }

  /** A stretch out of the middle of a file, which only its ciphertext may carry. */
  content(name: string, data: Buffer) {
    // A few bytes turn up anywhere by chance, so a short file is no proof either way.
    if (data.length < 32) return;
    const start = Math.floor((data.length - Math.min(data.length, 64)) / 2);
    this.needles.push({ name: `content of ${name}`, bytes: data.subarray(start, start + 64) });
  }
}

/** What the setup a project runs against promises, set per project in playwright.config.ts. */
export type TargetOptions = {
  /** The protocol between the browser and the first server, as `nextHopProtocol` names it. */
  protocol: "http/1.1" | "h2";
  /** How uploads travel, as the upload worker logs it. */
  uploadTransport: "ws" | "http";
};

type Fixtures = {
  guard: Guard;
  /** A page in a browser of its own, with nothing of the sender in it: the recipient. */
  openRecipient: () => Promise<Page>;
  /** The download path this engine takes, see apps/web/src/lib/download-tiers.ts. */
  expectedTier: string;
  /**
   * The transports the upload worker logged in every browser of the test. After the test each
   * one has to be the transport of the target, so a broken WebSocket cannot hide behind the
   * chunked fallback.
   */
  uploadTransports: string[];
};

function recordTransports(context: BrowserContext, transports: string[]) {
  context.on("console", (message) => {
    const transport = /\[upload-worker\] transport=(\w+)/.exec(message.text());
    if (transport) transports.push(transport[1]!);
  });
}

export const test = base.extend<Fixtures & TargetOptions>({
  protocol: ["http/1.1", { option: true }],
  uploadTransport: ["ws", { option: true }],

  uploadTransports: [
    async ({ context, uploadTransport }, use) => {
      const transports: string[] = [];
      recordTransports(context, transports);
      await use(transports);
      for (const transport of transports) {
        expect(transport, "uploads take the transport of the target").toBe(uploadTransport);
      }
    },
    { auto: true },
  ],

  guard: [
    async ({ request }, use) => {
      const guard = new Guard();
      await use(guard);
      if (guard.needles.length === 0) return;
      const hits = await scanServer(request, guard.needles);
      expect(hits, "nothing secret reached the server").toEqual([]);
    },
    { auto: true },
  ],

  openRecipient: async ({ browser, uploadTransports }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async () => {
      const context = await browser.newContext();
      recordTransports(context, uploadTransports);
      contexts.push(context);
      return context.newPage();
    });
    await Promise.all(contexts.map((context) => context.close()));
  },

  // Safari is kept off the Service Worker on purpose, and WebKit is close enough to count.
  expectedTier: async ({ browserName }, use) => {
    await use(browserName === "webkit" ? "3" : "1");
  },
});

export { expect };
