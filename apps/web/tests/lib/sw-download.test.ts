import { describe, it, expect, vi, afterEach } from "vitest";
import { activeWorker, DOWNLOAD_SW_URL, registerDownloadSw } from "../../src/lib/sw-download.js";

/** A worker whose state the test moves on. */
function worker(state: ServiceWorkerState) {
  const listeners: Array<() => void> = [];
  return {
    state,
    scriptURL: "https://host/download-sw.js",
    addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    become(next: ServiceWorkerState) {
      this.state = next;
      for (const listener of listeners) listener();
    },
  };
}

function registration(parts: {
  active?: unknown;
  installing?: unknown;
  waiting?: unknown;
  scope?: string;
}) {
  return {
    active: null,
    installing: null,
    waiting: null,
    scope: "https://host/__skysend_download__/",
    ...parts,
  } as unknown as ServiceWorkerRegistration;
}

function browserWith(reg: ServiceWorkerRegistration) {
  vi.stubGlobal("navigator", {
    serviceWorker: {
      register: vi.fn().mockResolvedValue(reg),
      getRegistrations: vi.fn().mockResolvedValue([]),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerDownloadSw", () => {
  it("registers the worker under the version of this release", async () => {
    const reg = registration({ active: worker("activated") });
    browserWith(reg);

    await registerDownloadSw();
    // A new release has a new URL, which makes the browser fetch the script again.
    expect(DOWNLOAD_SW_URL).toBe(`/download-sw.js?v=${__APP_VERSION__}`);
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith(DOWNLOAD_SW_URL, {
      scope: "/__skysend_download__/",
    });
  });

  it("removes a registration for the whole origin from a release before", async () => {
    const old = registration({ active: worker("activated"), scope: "https://host/" });
    const unregister = vi.fn().mockResolvedValue(true);
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: vi.fn().mockResolvedValue(registration({})),
        getRegistrations: vi.fn().mockResolvedValue([{ ...old, unregister }]),
      },
    });

    await registerDownloadSw();
    await vi.waitFor(() => expect(unregister).toHaveBeenCalledOnce());
  });
});

describe("activeWorker", () => {
  it("waits for a newer worker instead of handing the download to the one it replaces", async () => {
    const old = worker("activated");
    const next = worker("installing");
    const found = activeWorker(registration({ active: old, installing: next }));

    next.become("installed");
    next.become("activating");
    next.become("activated");
    expect(await found).toBe(next);
  });

  it("stays with the active worker when the newer one fails to install", async () => {
    const old = worker("activated");
    const next = worker("installing");
    const found = activeWorker(registration({ active: old, installing: next }));

    next.become("redundant");
    expect(await found).toBe(old);
  });

  it("takes the active worker when nothing newer is on its way", async () => {
    const old = worker("activated");
    expect(await activeWorker(registration({ active: old }))).toBe(old);
  });
});
