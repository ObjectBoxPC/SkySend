/**
 * Writes one download into a file of the origin private file system, through a sync access
 * handle, which only a dedicated worker gets. It writes straight to disk, so a file of many GB
 * never sits in memory. The main thread decrypts and sends the plaintext in batches, see
 * opfs-file.ts.
 *
 * Main → worker, one message at a time, each answered before the next:
 *   { type: "open", name }               → { type: "ready" }
 *   { type: "write", data, length }      → { type: "written" }
 *   { type: "close" }                    → { type: "closed", size }
 * Any failure answers { type: "error", message }.
 */

/** The part of FileSystemSyncAccessHandle this uses. The DOM lib of the app does not have it. */
interface SyncAccessHandle {
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
type SyncFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle(): Promise<SyncAccessHandle>;
};

let handle: SyncAccessHandle | null = null;
let size = 0;

self.onmessage = async (event: MessageEvent) => {
  const msg = event.data as
    | { type: "open"; name: string }
    | { type: "write"; data: ArrayBuffer; length: number }
    | { type: "close" };
  try {
    if (msg.type === "open") {
      const root = await navigator.storage.getDirectory();
      const file = (await root.getFileHandle(msg.name, { create: true })) as SyncFileHandle;
      handle = await file.createSyncAccessHandle();
      handle.truncate(0);
      size = 0;
      self.postMessage({ type: "ready" });
    } else if (msg.type === "write") {
      if (!handle) throw new Error("No file is open");
      const bytes = new Uint8Array(msg.data, 0, msg.length);
      // A write may take less than it was given, so it goes on until all of it is in.
      for (let done = 0; done < bytes.length; ) {
        const step = handle.write(bytes.subarray(done), { at: size + done });
        if (step <= 0) throw new Error("The disk took no more bytes");
        done += step;
      }
      size += bytes.length;
      self.postMessage({ type: "written" });
    } else if (msg.type === "close") {
      if (!handle) throw new Error("No file is open");
      handle.flush();
      handle.close();
      handle = null;
      self.postMessage({ type: "closed", size });
    }
  } catch (err) {
    self.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
