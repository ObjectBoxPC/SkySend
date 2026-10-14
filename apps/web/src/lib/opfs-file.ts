/**
 * Saving a download through the origin private file system (OPFS), for a browser that has no
 * Service Worker tier. That is Safari above all: it never streams a Service Worker response
 * into a download, and a Blob of a few GB made in memory crashes its tab. Here the plaintext
 * goes to disk in batches as it is decrypted, through a worker (opfs-file-worker.ts), and the
 * finished file is handed to the browser as a download from there. Safari copies it to the
 * Downloads folder without reading it into the page, 2.5 GB tested on Safari 27.
 *
 * The file holds plaintext, so it is removed once the download manager had time to copy it,
 * and a download in any tab removes the ones older than an hour that a closed tab left behind.
 */

import { formatBytes, isBrave } from "@/lib/utils";

const PREFIX = "skysend-download-";
/** Plaintext goes to the worker in batches of this size, one on its way while the next fills. */
const BATCH = 8 * 1024 * 1024;
/** What the quota has to leave free beyond the file. */
const MARGIN = 64 * 1024 * 1024;
/** A file older than this belongs to no tab that is still handing it over. */
const STALE_MS = 60 * 60 * 1000;
/** How long the download manager gets at the least to copy a file, and how fast it copies. */
const KEEP_MIN_MS = 2 * 60 * 1000;
const KEEP_BYTES_PER_SECOND = 20 * 1024 * 1024;

type Answer = { type: "ready" } | { type: "written" } | { type: "closed"; size: number };

/** The worker, answering one message at a time. */
function openWorker() {
  const worker = new Worker(new URL("./opfs-file-worker.ts", import.meta.url), {
    type: "module",
  });
  let waiting: { resolve: (answer: Answer) => void; reject: (err: Error) => void } | null = null;
  const settle = (outcome: Answer | Error) => {
    const current = waiting;
    waiting = null;
    if (!current) return;
    if (outcome instanceof Error) current.reject(outcome);
    else current.resolve(outcome);
  };
  worker.onmessage = (event: MessageEvent<Answer | { type: "error"; message: string }>) => {
    const data = event.data;
    settle(data.type === "error" ? new Error(data.message) : data);
  };
  worker.onerror = (event) => settle(new Error(event.message || "OPFS worker error"));
  return {
    call(message: object, transfer: Transferable[] = []): Promise<Answer> {
      return new Promise((resolve, reject) => {
        waiting = { resolve, reject };
        worker.postMessage(message, transfer);
      });
    },
    terminate: () => worker.terminate(),
  };
}

function timeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("OPFS timed out")), ms)),
  ]);
}

/**
 * Removes a file, once more a second later if it was still locked: a terminated worker lets go
 * of its handle a moment after.
 */
function remove(name: string): void {
  const attempt = () => navigator.storage.getDirectory().then((root) => root.removeEntry(name));
  attempt().catch(() => setTimeout(() => attempt().catch(() => {}), 1000));
}

/** Removes the files of downloads older than STALE_MS, left by a tab that was closed. */
async function sweep(): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    const names: string[] = [];
    for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
      names.push(name);
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.startsWith(PREFIX)) continue;
      const at = Number(name.slice(PREFIX.length).split("-")[0]);
      if (!(now - at < STALE_MS)) await root.removeEntry(name).catch(() => {});
    }
  } catch {
    // The next download sweeps again.
  }
}

let works: Promise<boolean> | null = null;

/**
 * Whether OPFS works here from end to end: a worker writes a small file and the page reads back
 * its size. An incognito context may refuse OPFS, and WebKitGTK reads back an empty file, so
 * only the whole round trip says yes. Checked once per page.
 */
function opfsWorks(): Promise<boolean> {
  works ??= (async () => {
    if (typeof Worker === "undefined" || !navigator.storage?.getDirectory) return false;
    const name = `${PREFIX}${Date.now()}-probe-${crypto.randomUUID()}`;
    const worker = openWorker();
    try {
      await timeout(worker.call({ type: "open", name }), 5000);
      const data = new Uint8Array(1024);
      await timeout(
        worker.call({ type: "write", data: data.buffer, length: 1024 }, [data.buffer]),
        5000,
      );
      await timeout(worker.call({ type: "close" }), 5000);
      const root = await navigator.storage.getDirectory();
      return (await (await root.getFileHandle(name)).getFile()).size === 1024;
    } catch {
      return false;
    } finally {
      worker.terminate();
      remove(name);
    }
  })();
  return works;
}

/** Why a download of `size` bytes cannot be saved through OPFS here, or null when it can. */
async function opfsProblem(size: number): Promise<string | null> {
  try {
    if (!(await opfsWorks())) return "OPFS does not work in this browser";
    const { quota = 0, usage = 0 } = await navigator.storage.estimate();
    // Brave reports a quota of exactly 2 GiB whatever it allows, against fingerprinting, and
    // took 3.2 GB into OPFS in a normal profile in a test, so that number says nothing.
    if (isBrave() && quota === 2 ** 31) return null;
    const free = Math.max(0, quota - usage);
    if (free >= size + MARGIN) return null;
    return `${formatBytes(free)} free, ${formatBytes(size + MARGIN)} needed`;
  } catch {
    return "OPFS does not work in this browser";
  }
}

/** Whether a download of `size` bytes can be saved through OPFS in this browser. */
export async function opfsFits(size: number): Promise<boolean> {
  return (await opfsProblem(size)) === null;
}

export interface OpfsFile {
  /** Takes the next piece of plaintext and resolves once it may be handed the next one. */
  write(chunk: Uint8Array): Promise<void>;
  /** Writes what is left and returns the file, checked against the bytes it was given. */
  finish(): Promise<File>;
  /** Hands the finished file to the browser as a download and removes it later. */
  save(file: File, filename: string): void;
  /** Stops and removes the file. */
  abort(): void;
}

/**
 * Opens a file for a download of `size` bytes, or returns null when OPFS cannot hold it here
 * and tells `onUnavailable` why. Everything that could fail before the download starts is
 * checked first, so a browser falls back to another tier without having used up a download of
 * a limited share.
 */
export async function createOpfsFile(
  size: number,
  onUnavailable?: (reason: string) => void,
): Promise<OpfsFile | null> {
  const problem = await opfsProblem(size);
  if (problem) {
    onUnavailable?.(problem);
    return null;
  }
  void sweep();
  const name = `${PREFIX}${Date.now()}-${crypto.randomUUID()}`;
  const worker = openWorker();
  try {
    await timeout(worker.call({ type: "open", name }), 5000);
  } catch {
    worker.terminate();
    remove(name);
    onUnavailable?.("OPFS did not open the file");
    return null;
  }

  let batch = new Uint8Array(BATCH);
  let filled = 0;
  let written = 0;
  let inFlight: Promise<unknown> = Promise.resolve();

  /** Waits for the batch before, then hands this one over and starts the next. */
  const send = async () => {
    await inFlight;
    const data = batch;
    const length = filled;
    batch = new Uint8Array(BATCH);
    filled = 0;
    written += length;
    inFlight = worker.call({ type: "write", data: data.buffer, length }, [data.buffer]);
  };

  return {
    async write(chunk) {
      for (let offset = 0; offset < chunk.length;) {
        const take = Math.min(BATCH - filled, chunk.length - offset);
        batch.set(chunk.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === BATCH) await send();
      }
    },

    async finish() {
      if (filled > 0) await send();
      await inFlight;
      const closed = await worker.call({ type: "close" });
      worker.terminate();
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle(name)).getFile();
      if (closed.type !== "closed" || closed.size !== written || file.size !== written) {
        remove(name);
        throw new Error("The saved file does not match the download");
      }
      return file;
    },

    save(file, filename) {
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      const keep = Math.max(KEEP_MIN_MS, (file.size / KEEP_BYTES_PER_SECOND) * 1000);
      setTimeout(() => {
        URL.revokeObjectURL(url);
        remove(name);
      }, keep);
    },

    abort() {
      worker.terminate();
      remove(name);
    },
  };
}
