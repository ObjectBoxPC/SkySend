# Download Modes

SkySend uses a tiered download strategy to handle large encrypted files (multi-GB) without exhausting browser RAM. The frontend automatically selects the best available mode based on browser capabilities.

## Overview

| Tier | Name | Browsers | RAM Usage | Progress | Speed |
| --- | --- | --- | --- | --- | --- |
| 1 | SW Streaming Decrypt | All modern browsers except Safari | Low (buffers only) | Yes | Very fast |
| 2 | File System Access | Chrome, Edge (fallback) | ~0 | Yes | Fast |
| 3 | OPFS | Safari, and any browser where tiers 1 and 2 are unavailable | ~0 | Yes | Fast |
| 4 | Blob Fallback | All (last resort) | Full file size | Yes | Moderate |

Tier 1 (SW stream) is attempted first because it is the fastest method. It runs decryption in the Service Worker thread, keeping the main thread free. Safari is excluded from Tier 1: it never streams a Service Worker response into a download, a test on Safari 27 stayed at zero bytes for a file of 1 GB. If the Service Worker is not available on other browsers, Tier 2 (`showSaveFilePicker`) is used in Chrome and Edge. Tier 3 (OPFS) writes the decrypted file to disk and hands it over from there, which is how Safari downloads files of several GB. Tier 4 (Blob) is the last resort, and the only one that holds the whole file in memory.

On a Mac with Safari 27, a file of 2.5 GB came down through Tier 3 at 124 MB/s over a gigabit link, with Safari at about 300 MB of memory. Through Tier 4 the same file crashed the tab.

## Tier 1: Service Worker Streaming Decryption

**Browsers**: All modern browsers except Safari (Chrome, Edge, Firefox, Brave)

The primary download method. The Service Worker performs the entire pipeline: fetch, HKDF key derivation, ECE decryption, and streaming the plaintext as a `Response` to the browser's download manager. This is the fastest method because decryption runs on the SW thread (not the main thread).

```
Service Worker (inside respondWith):
  fetch(encrypted) --> HKDF deriveKey --> ECE decrypt --> ReadableStream --> Download Manager
```

### How it works

1. Main thread checks that the download Service Worker is active (`ensureSwController()`). It controls no page, only the URLs under `/__skysend_download__/`
2. Main thread sends the download config to the SW with `postMessage` on the worker: URL, auth token, raw secret, salt, filename, MIME type, encrypted size. That message starts the worker when the browser stopped it, which every browser does after about 30 seconds without work. The same config goes over the `skysend-download` BroadcastChannel as well, for an active worker of an older release. The SW keeps the first copy, answers `config-ok` and stays up until the download arrives, a minute at most
3. Main thread navigates to `/__skysend_download__/{id}`
4. SW intercepts the navigation, which lies in its scope, and calls `handleDownload()` inside `respondWith()`
5. SW derives the AES-256-GCM file key via HKDF (using `crypto.subtle`)
6. SW fetches the encrypted file from the server
7. SW creates a `ReadableStream` with a `pull()` function that:
   - Reads encrypted data from the fetch response
   - Buffers until a complete ECE record (65,552 bytes) is available
   - Decrypts the record with `crypto.subtle.decrypt()`
   - Enqueues the plaintext chunk
8. SW returns `new Response(decryptStream, { headers })` with `Content-Disposition: attachment`
9. Browser download manager writes to disk natively
10. SW reports progress and completion back to main thread over the `skysend-download` BroadcastChannel

### Why this is necessary for Firefox

Firefox does not propagate backpressure from a `ReadableStream` consumer back through `fetch()` when the fetch happens in a Web Worker or on the main thread. The entire HTTP response body gets buffered in RAM regardless of how fast the consumer reads.

However, when `fetch()` happens **inside a Service Worker's `respondWith()`**, it becomes part of the browser's native download pipeline. Firefox manages the network read speed based on how fast the download manager writes to disk. This is the same technique [Mozilla Send](https://github.com/mozilla/send) used.

### Key design decisions

- **One record per `pull()`**: `pull()` enqueues exactly one decrypted record, and `highWaterMark: 8` keeps a few ready. Enqueueing several per call made Firefox lose its backpressure state and stall.
- **Chunk queue without copies**: network chunks are held by reference and only the bytes of the current record are copied, into a scratch buffer that is reused.
- **Inline crypto**: The SW is plain JavaScript (no module imports). ECE constants, `nonceXorCounter()`, and HKDF key derivation are inlined directly because Service Workers cannot import from bundled modules.

### RAM impact

Low but not zero. Firefox uses internal buffers for the HTTP response and the download manager's write pipeline. For a 5.7 GB file, expect approximately 1-3 GB of transient RAM usage that gets reclaimed by GC as the download progresses. With less available RAM, Firefox will slow down the fetch (backpressure kicks in at a lower watermark) - the download simply takes longer but still completes.

### Progress reporting

The SW reports progress to the main thread via `client.postMessage({ type: "dl-progress", progress })` (throttled to every 300ms) and signals completion with `{ type: "dl-done" }`. The main thread listens for these messages and updates the UI.

### Key files

- [download-sw.js](https://github.com/Skyfay/SkySend/blob/main/apps/web/public/download-sw.js) - Service Worker with inline ECE decryption
- [sw-download.ts](https://github.com/Skyfay/SkySend/blob/main/apps/web/src/lib/sw-download.ts) - `registerDownloadSw()`, `ensureSwController()`, `streamDownloadViaSw()`

---

## Tier 2: File System Access API (Fallback)

**Browsers**: Chrome 86+, Edge 86+ (only used if SW stream fails)

Uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) (`showSaveFilePicker`) to stream decrypted data directly to a user-chosen file on disk. This was the original primary method but is now a fallback because SW stream is faster.

```
Main Thread: fetch() --> decrypt (TransformStream) --> pipeTo(FileSystemWritableFileStream)
```

### How it works

1. Call `showSaveFilePicker()` - user selects save location
2. Open a `FileSystemWritableFileStream` on the selected file
3. Fetch encrypted data from the server
4. Pipe through a progress `TransformStream`
5. Pipe through `createDecryptStream(fileKey)` (ECE AES-256-GCM)
6. Pipe directly to the writable file stream

### Why it works

The entire pipeline is a chain of `TransformStream` stages connected via `pipeThrough()` and `pipeTo()`. Backpressure propagates naturally - the file system write speed controls how fast data is read from the network.

### RAM impact

Near zero. Only the current record (64 KB plaintext + 16 bytes GCM tag) is in memory at any time.

### Key files

- [download-tiers.ts](https://github.com/Skyfay/SkySend/blob/main/apps/web/src/lib/download-tiers.ts) - Tier selection logic, shared by downloads and the inbox of a file request
- [useDownload.ts](https://github.com/Skyfay/SkySend/blob/main/apps/web/src/hooks/useDownload.ts) - File info, password and the browser warnings before the tiers run

---

## Tier 3: OPFS

**Browsers**: Safari, and any other browser where neither Tier 1 nor Tier 2 is available

The main thread fetches and decrypts as in Tier 2, and a dedicated worker writes the plaintext into a file of the [origin private file system](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system) through a sync access handle, which writes straight to disk. The finished file is handed to the browser as a download through an object URL of the OPFS `File`. Safari copies that file into the Downloads folder without reading it into the page.

```
Main Thread: fetch() --> decrypt --> batches of 8 MiB --> Worker: SyncAccessHandle.write()
Main Thread: getFile() --> createObjectURL --> <a download>
```

### How it works

1. `createOpfsFile()` checks everything that could fail before anything is fetched, since a fetch uses up a download of a limited share: that OPFS works from end to end (a worker writes 1 KiB and the page reads back its size), and that the quota leaves room for the file plus 64 MiB
2. The worker opens a file named `skysend-download-<time>-<uuid>` with a sync access handle
3. The main thread decrypts and hands the plaintext over in batches of 8 MiB, one on its way while the next fills, so memory stays at about 16 MiB
4. After the last batch the worker closes the file, and the page checks its size against the bytes it wrote
5. The page clicks an `<a download>` with an object URL of the file

The OPFS file holds plaintext. It is removed once the download manager has had time to copy it, at least two minutes and longer for a large file, and a download in any tab removes the files older than an hour that a closed tab left behind.

### Where it does not work

The end-to-end check catches browsers whose OPFS fails. A private window may refuse OPFS or offer too little quota, and WebKit on Linux, which the end-to-end tests run, reads back an empty file. These go on to Tier 4. On Safari the warning before a large download is only shown when Tier 3 cannot take the file.

Brave reports a quota of exactly 2 GiB whatever it allows, against fingerprinting. A normal Brave profile took 3.2 GB into OPFS in a test, so Brave's number is not held against a file. A private window of Brave or Chrome stops writing at about 2 GB, whatever its quota says, so a large file can still fail there in Tier 3. Both reach Tier 3 only when the Service Worker cannot start, like on a page whose certificate error was clicked away: Chromium registers no Service Worker for such a page.

### Why a tier was passed over

The technical info of a download lists why every faster tier was passed over before the one that ran: the reason the Service Worker did not start, like "An SSL certificate error occurred when fetching the script.", a browser without a file picker, or the room OPFS has against what the file needs. A report of a download that landed in Tier 4 says that way what stopped the others.

The download manager of Safari shows no progress while it copies the finished file. The page shows the real progress of the download before that.

### Key files

- [opfs-file.ts](https://github.com/Skyfay/SkySend/blob/main/apps/web/src/lib/opfs-file.ts) - `opfsFits()`, `createOpfsFile()`, the batching and the handover
- [opfs-file-worker.ts](https://github.com/Skyfay/SkySend/blob/main/apps/web/src/lib/opfs-file-worker.ts) - the worker with the sync access handle

---

## Tier 4: Blob Fallback

**Browsers**: All (last resort)

Collects all decrypted chunks into a `Blob`, creates an object URL, and triggers a download via an anchor element. Reached only when Tiers 1 to 3 are all unavailable, like Safari in a private window. On Safari a warning is displayed before a download larger than 256 MB.

```
Main Thread: fetch() --> decrypt --> collect chunks[] --> new Blob() --> createObjectURL --> <a download>
```

### RAM impact

The entire decrypted file is held in RAM. For large files this will cause the browser to slow down or crash: Safari 27 handled 1 GB and reloaded the tab at 2.5 GB.

### Key files

- [download-tiers.ts](https://github.com/Skyfay/SkySend/blob/main/apps/web/src/lib/download-tiers.ts) - Blob fallback at the end of `saveDecryptedDownload()`

---

## Truncation Check

Every tier checks the decrypted size against the size from the authenticated metadata, the file size for a single file and `archiveSize` for an archive. Each ECE record is authenticated on its own, so a server that drops whole records from the end of a file leaves a stream that still decrypts cleanly. Only the size reveals it.

- Tier 1 hands the size to the Service Worker, which fails the stream with `Stream truncation detected` instead of closing it. It also uses the size as `Content-Length`, so the browser sees a short body as an incomplete download.
- Tiers 2 to 4 pass the size to `createDecryptStream()`. A failed `pipeTo()` aborts the writable, which discards the partial file, Tier 3 removes its OPFS file, and Tier 4 never builds the Blob.
- A truncated download does not fall through to the next tier. Every tier fetches the same ciphertext, so a retry would only repeat the download and use up a download from the limit. Tiers 3 and 4 do not fall through on any failure once they fetched.
- A download without metadata fails before anything is fetched. Archives uploaded by older clients carry no `archiveSize` and skip the check.

## Download Sources

A normal download and a file in the inbox of a [file request](/user-guide/file-requests) run through the same four tiers. They differ only in where the ciphertext comes from, which the caller passes to `saveDecryptedDownload()` as a source:

| Caller | Endpoint | Token header |
| --- | --- | --- |
| `useDownload.ts` | `GET /api/download/:id` | `X-Auth-Token` |
| `useInbox.ts` | `GET /api/inbox/:id/file/:uid` | `X-Inbox-Token` |

The Service Worker takes the header name from the config message, but only from an allowlist of these two. Anything else falls back to `X-Auth-Token`. The name and the MIME type of the file come from whoever uploaded it, so the Service Worker also falls back to safe values when either would make building the response headers throw.

## Tier Selection Logic

The selection happens in `saveDecryptedDownload()` in `lib/download-tiers.ts`:

```typescript
const safari = isSafari();

// Tier 1: SW stream (all browsers except Safari)
const sw = !safari ? await ensureSwController() : null;
if (sw) {
  // Send config to SW, navigate to intercepted URL, wait for completion
}

// Tier 2: showSaveFilePicker fallback (Chrome, Edge)
if (!downloaded && typeof window.showSaveFilePicker === "function") {
  // Open file picker, stream decrypt to file
}

// Tier 3: OPFS (Safari), checked before anything is fetched
if (!downloaded) {
  const disk = await createOpfsFile(plaintextSize ?? size);
  // Decrypt into the OPFS file, then hand it over as a download
}

// Tier 4: Blob fallback (last resort)
if (!downloaded) {
  // Collect chunks, create Blob, trigger download
}
```

## Service Worker Registration

The Service Worker (`download-sw.js`) is registered in `main.tsx` through `registerDownloadSw()` in `sw-download.ts`, with the scope `/__skysend_download__/`:

```typescript
navigator.serviceWorker.register("/download-sw.js", { scope: DOWNLOAD_SW_SCOPE });
```

The scope is the URLs tier 1 navigates to and nothing else. A navigation reaches the worker of the scope it lies in even from a page no worker controls, so tier 1 works the same. Releases before 2026-10 registered it for the whole origin, which put every request of every page through its fetch handler, the requests of an upload among them. Chromium keeps the body of such a request alive in blob memory, and a chunked upload of 2 GiB in an incognito window failed with `ERR_BLOB_OUT_OF_MEMORY`. `registerDownloadSw()` removes such an old registration.

The SW uses `skipWaiting()` to activate immediately, so `ensureSwController()` waits for the active worker of the registration, not for `navigator.serviceWorker.controller`, which stays empty. The server must serve `/download-sw.js` with the correct MIME type (`application/javascript`) - a dedicated route exists in the Hono server to prevent the SPA catch-all from serving it as `index.html`.

## Browser Compatibility Matrix

| Feature | Chrome | Edge | Firefox | Safari | Brave |
| --- | --- | --- | --- | --- | --- |
| `showSaveFilePicker` | 86+ | 86+ | No | No | No |
| OPFS with sync access handles | 102+ | 102+ | 111+ | Yes (tested on 27) | 102+ |
| Service Worker | Yes | Yes | Yes | Yes | Yes |
| SW response streamed into a download | Yes | Yes | Yes | No | Yes |
| Download tier used | 1 (SW) | 1 (SW) | 1 (SW) | 3 (OPFS) | 1 (SW) |
