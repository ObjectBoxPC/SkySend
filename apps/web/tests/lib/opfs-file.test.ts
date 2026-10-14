import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/** A worker that writes into memory the way opfs-file-worker.ts writes into OPFS. */
class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  private size = 0;
  postMessage(message: { type: string; length?: number }) {
    const answer =
      message.type === "open"
        ? { type: "ready" }
        : message.type === "write"
          ? ((this.size += message.length ?? 0), { type: "written" })
          : { type: "closed", size: this.size };
    queueMicrotask(() => this.onmessage?.({ data: answer }));
  }
  terminate() {}
}

/** A browser whose OPFS works and whose storage reports this quota. */
function browser(quota: number, brave: boolean) {
  const storage = {
    estimate: async () => ({ quota, usage: 0 }),
    getDirectory: async () => ({
      getFileHandle: async () => ({ getFile: async () => ({ size: 1024 }) }),
      removeEntry: async () => {},
    }),
  };
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("navigator", brave ? { storage, brave: {} } : { storage });
}

const GB = 1e9;

beforeEach(() => {
  // opfsWorks() answers once per page, so every test loads the module anew.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("opfsFits", () => {
  it("takes a download the reported quota holds and refuses one it does not", async () => {
    browser(10 * GB, false);
    const { opfsFits } = await import("../../src/lib/opfs-file.js");

    expect(await opfsFits(3.5 * GB)).toBe(true);
    expect(await opfsFits(9.99 * GB)).toBe(false);
  });

  it("does not believe the 2 GiB Brave reports whatever it allows", async () => {
    browser(2 ** 31, true);
    const { opfsFits } = await import("../../src/lib/opfs-file.js");

    expect(await opfsFits(3.5 * GB)).toBe(true);
  });

  it("still trusts a quota of another size in Brave", async () => {
    browser(3 * GB, true);
    const { opfsFits } = await import("../../src/lib/opfs-file.js");

    expect(await opfsFits(3.5 * GB)).toBe(false);
  });

  it("refuses when OPFS reads back less than the probe wrote", async () => {
    browser(10 * GB, false);
    vi.stubGlobal("navigator", {
      storage: {
        estimate: async () => ({ quota: 10 * GB, usage: 0 }),
        getDirectory: async () => ({
          getFileHandle: async () => ({ getFile: async () => ({ size: 0 }) }),
          removeEntry: async () => {},
        }),
      },
    });
    const { opfsFits } = await import("../../src/lib/opfs-file.js");

    expect(await opfsFits(1000)).toBe(false);
  });
});
