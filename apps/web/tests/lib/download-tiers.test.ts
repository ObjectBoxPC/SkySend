// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("@skysend/crypto", () => ({
  createDecryptStream: () => new TransformStream<Uint8Array, Uint8Array>(),
}));

vi.mock("../../src/lib/sw-download.js", () => ({
  ensureSwController: vi.fn(),
  streamDownloadViaSw: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/lib/utils.js", () => ({
  isSafari: vi.fn(() => false),
  isFirefox: vi.fn(() => false),
  isBrave: vi.fn(() => false),
  isDevToolsOpen: vi.fn(() => false),
  getBrowserInfo: vi.fn(() => "test"),
  formatBytes: vi.fn((n: number) => `${n} B`),
}));

import * as opfs from "../../src/lib/sw-download.js";
import {
  saveDecryptedDownload,
  type DownloadDebugInfo,
  type SaveDownloadOptions,
} from "../../src/lib/download-tiers.js";

function options(overrides: Partial<SaveDownloadOptions> = {}): SaveDownloadOptions {
  return {
    source: {
      path: "/api/inbox/req/file/up",
      token: "inbox-token",
      tokenHeader: "X-Inbox-Token",
      fetchCiphertext: vi.fn(),
    },
    secret: new Uint8Array(32),
    salt: new Uint8Array(32),
    fileKey: {} as CryptoKey,
    filename: "a.pdf",
    mimeType: "application/pdf",
    size: 3,
    plaintextSize: 3,
    signal: new AbortController().signal,
    onProgress: vi.fn(),
    onDebug: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("saveDecryptedDownload", () => {
  it("hands the Service Worker the endpoint and the header of the source", async () => {
    vi.mocked(opfs.ensureSwController).mockResolvedValueOnce({} as ServiceWorker);
    const opts = options();
    await saveDecryptedDownload(opts);
    const call = vi.mocked(opfs.streamDownloadViaSw).mock.calls[0]!;
    expect(call[0]).toBe(`${window.location.origin}/api/inbox/req/file/up`);
    expect(call[1]).toBe("inbox-token");
    expect(call[11]).toBe(3);
    expect(call[12]).toBe("X-Inbox-Token");
    expect(opts.source.fetchCiphertext).not.toHaveBeenCalled();
  });

  it("falls back to a blob through the same source when the Service Worker fails", async () => {
    vi.mocked(opfs.ensureSwController).mockResolvedValueOnce({} as ServiceWorker);
    vi.mocked(opfs.streamDownloadViaSw).mockRejectedValueOnce(new Error("SW config timeout"));
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const fetchCiphertext = vi.fn().mockResolvedValue({
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
      size: 3,
      storageBackend: "filesystem",
    });
    const onProgress = vi.fn();
    const opts = options({
      source: { path: "/p", token: "t", tokenHeader: "X-Inbox-Token", fetchCiphertext },
      onProgress,
    });
    await saveDecryptedDownload(opts);
    expect(fetchCiphertext).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith(0, 0);
    expect(onProgress).toHaveBeenLastCalledWith(100, 3);
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("says in the timeline why the faster tiers were passed over", async () => {
    // What Chromium answers on a page whose certificate error was clicked away.
    vi.mocked(opfs.ensureSwController).mockImplementationOnce(async (onUnavailable) => {
      onUnavailable?.("An SSL certificate error occurred when fetching the script.");
      return null;
    });
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const fetchCiphertext = vi.fn().mockResolvedValue({
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.close();
        },
      }),
      size: 3,
      storageBackend: "filesystem",
    });
    let info: DownloadDebugInfo | null = null;
    await saveDecryptedDownload(
      options({
        source: { path: "/p", token: "t", tokenHeader: "X-Inbox-Token", fetchCiphertext },
        onDebug: (update) => {
          info = update(info);
        },
      }),
    );

    // jsdom has no file picker and no Worker, so OPFS is out too.
    const events = (info as DownloadDebugInfo | null)?.events ?? [];
    expect(events.map((e) => [e.message, e.detail])).toEqual([
      [
        "Service Worker not available",
        "An SSL certificate error occurred when fetching the script.",
      ],
      ["Save File Picker not available", "This browser has none"],
      ["OPFS not used", "OPFS does not work in this browser"],
      ["Blob fallback started", undefined],
    ]);
  });

  it("stops at a cancel instead of falling back", async () => {
    vi.mocked(opfs.ensureSwController).mockResolvedValueOnce({} as ServiceWorker);
    vi.mocked(opfs.streamDownloadViaSw).mockRejectedValueOnce(
      new DOMException("cancelled", "AbortError"),
    );
    const opts = options();
    await expect(saveDecryptedDownload(opts)).rejects.toThrow("cancelled");
    expect(opts.source.fetchCiphertext).not.toHaveBeenCalled();
  });
});
