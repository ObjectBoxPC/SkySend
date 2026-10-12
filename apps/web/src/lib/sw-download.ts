/**
 * Tier 1 of the download: the Service Worker in public/download-sw.js fetches the ciphertext,
 * decrypts it inside respondWith() and streams it to the browser's download manager, so the
 * file never sits in memory. This module registers that worker and drives one download.
 */

const downloadBc = new BroadcastChannel("skysend-download");

/**
 * Where the download Service Worker works: the URLs tier 1 navigates to, and nothing else.
 * Registered for the whole origin, it saw every request of every page, uploads among them,
 * and Chromium keeps the body of each such request alive in blob memory, which ran a chunked
 * upload of 2 GiB out of it in an incognito window. A navigation to a URL in its scope still
 * reaches it, so tier 1 needs no page it controls.
 */
export const DOWNLOAD_SW_SCOPE = "/__skysend_download__/";

/**
 * Registers the download Service Worker. Releases before 2026-10 registered it for the whole
 * origin, so such a registration is removed. The page it controls right now stays controlled
 * until it navigates.
 */
export function registerDownloadSw(): Promise<ServiceWorkerRegistration> {
  navigator.serviceWorker
    .getRegistrations()
    .then((registrations) => {
      for (const registration of registrations) {
        const worker = registration.active ?? registration.waiting ?? registration.installing;
        const script = worker ? new URL(worker.scriptURL).pathname : "";
        if (script === "/download-sw.js" && new URL(registration.scope).pathname === "/") {
          void registration.unregister();
        }
      }
    })
    .catch(() => {});
  return navigator.serviceWorker.register("/download-sw.js", { scope: DOWNLOAD_SW_SCOPE });
}

/** The active worker of a registration, waiting for one that is still installing. */
function activeWorker(registration: ServiceWorkerRegistration): Promise<ServiceWorker | null> {
  if (registration.active) return Promise.resolve(registration.active);
  const pending = registration.installing ?? registration.waiting;
  if (!pending) return Promise.resolve(null);
  return new Promise((resolve) => {
    pending.addEventListener("statechange", () => {
      if (pending.state === "activated") resolve(pending);
      if (pending.state === "redundant") resolve(null);
    });
  });
}

/**
 * Waits until the download Service Worker is active. It controls no page, see
 * DOWNLOAD_SW_SCOPE, so this waits for the worker itself, not for a controller.
 * Has a hard timeout, since a registration that fails to install never activates.
 */
export async function ensureSwController(): Promise<ServiceWorker | null> {
  if (!("serviceWorker" in navigator)) return null;

  const result = await Promise.race([
    (async () => {
      try {
        // Registered from main.tsx already, which this finds again.
        return await activeWorker(await registerDownloadSw());
      } catch (err) {
        console.warn("[SkySend] SW registration failed:", err);
        return null;
      }
    })(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);

  if (result) {
    console.info("[SkySend] Service Worker ready");
  } else {
    console.warn("[SkySend] Service Worker not available (timeout or failed)");
  }
  return result;
}

/**
 * Stream download via Service Worker (no Worker, no OPFS needed).
 *
 * Flow: SW fetches encrypted file, decrypts with ECE, streams to download manager.
 * All inside respondWith() - Firefox propagates backpressure correctly there.
 *
 * The SW reports progress and completion back via postMessage (dl-progress, dl-done).
 * `plaintextSize` is the size from the authenticated metadata. The SW fails the
 * download when the decrypted stream ends up any other size. `tokenHeader` names the
 * header the SW sends the token in: X-Auth-Token for a download, X-Inbox-Token for a
 * file in the inbox of a file request.
 */
export async function streamDownloadViaSw(
  url: string,
  authToken: string,
  secret: ArrayBuffer,
  salt: ArrayBuffer,
  filename: string,
  mimeType: string,
  encryptedSize: number,
  onProgress: (progress: number) => void,
  onDebugInfo?: (swPath: string) => void,
  signal?: AbortSignal,
  onS3Info?: () => void,
  plaintextSize?: number,
  tokenHeader: "X-Auth-Token" | "X-Inbox-Token" = "X-Auth-Token",
): Promise<void> {
  const sw = await ensureSwController();
  if (!sw) throw new Error("Service Worker not available");

  // If already aborted before we even start, bail out immediately.
  if (signal?.aborted) throw new DOMException("Download cancelled", "AbortError");

  const downloadId = crypto.randomUUID();

  // Send config to SW and wait for ACK
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      downloadBc.removeEventListener("message", handler);
      reject(new Error("SW config timeout"));
    }, 5000);

    const abortHandler = () => {
      clearTimeout(timeout);
      downloadBc.removeEventListener("message", handler);
      reject(new DOMException("Download cancelled", "AbortError"));
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    const handler = (e: MessageEvent) => {
      if (e.data?.type === "config-ok" && e.data?.id === downloadId) {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abortHandler);
        downloadBc.removeEventListener("message", handler);
        resolve();
      }
    };

    downloadBc.addEventListener("message", handler);
    downloadBc.postMessage({
      type: "config",
      id: downloadId,
      url,
      authToken,
      tokenHeader,
      secret,
      salt,
      filename,
      mimeType,
      size: encryptedSize,
      plaintextSize,
    });
  });

  // When the caller aborts, tell the SW to cancel the in-progress download.
  // The SW will set cancelled=true, cancel the reader, error the stream, and
  // send back a "dl-cancelled" message so we can clean up the promise below.
  signal?.addEventListener("abort", () => {
    downloadBc.postMessage({ type: "cancel", id: downloadId });
  }, { once: true });

  // Trigger download via <a> navigation (no download attribute).
  // Without the download attribute the browser treats this as a regular navigation,
  // which the SW intercepts and answers with Content-Disposition: attachment -
  // so the browser hands it to the download manager natively.
  //
  // We do NOT use <a download> because Chrome/Edge/Brave do not fire the SW
  // fetch event for <a download> clicks.
  //
  // We do NOT use an iframe because Firefox truncates SW streams during the
  // iframe -> download manager handoff, cutting large files at ~40-50%.
  // (Mozilla Send uses this same <a> approach for the same reason.)
  const a = document.createElement("a");
  a.href = `/__skysend_download__/${downloadId}`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  // Wait for SW to signal completion (dl-done, dl-error, or dl-cancelled).
  // Messages are filtered by downloadId (not clientId, which is empty for navigations).
  await new Promise<void>((resolve, reject) => {
    let gotFirstMessage = false;

    // If the SW never responds (e.g. SW not active),
    // reject quickly so fallback tiers can take over.
    const initialTimeout = setTimeout(() => {
      if (!gotFirstMessage) {
        downloadBc.removeEventListener("message", handler);
        reject(new Error("Service Worker did not respond"));
      }
    }, 10_000);

    const completionTimeout = setTimeout(() => {
      downloadBc.removeEventListener("message", handler);
      resolve(); // Don't error on timeout - download may have completed
    }, 86_400_000);

    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.downloadId !== downloadId) return;

      if (!gotFirstMessage) {
        gotFirstMessage = true;
        clearTimeout(initialTimeout);
      }

      if (msg.type === "dl-progress") {
        onProgress(msg.progress);
      } else if (msg.type === "dl-tier") {
        onDebugInfo?.(msg.swPath);
      } else if (msg.type === "dl-s3") {
        onS3Info?.();
      } else if (msg.type === "dl-done") {
        clearTimeout(completionTimeout);
        downloadBc.removeEventListener("message", handler);
        resolve();
      } else if (msg.type === "dl-cancelled") {
        // User-initiated cancel via the cancel button - throw AbortError so the
        // caller can distinguish a clean cancel from a real download error and
        // skip fallback tiers.
        clearTimeout(completionTimeout);
        downloadBc.removeEventListener("message", handler);
        reject(new DOMException("Download cancelled by user", "AbortError"));
      } else if (msg.type === "dl-error") {
        clearTimeout(completionTimeout);
        downloadBc.removeEventListener("message", handler);
        reject(new Error(msg.error || "Download failed in SW"));
      }
    };

    downloadBc.addEventListener("message", handler);
  });
}
