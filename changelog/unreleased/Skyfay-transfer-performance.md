### ✨ Features

- **web**: Safari downloads large files to disk instead of into memory, so files of several GB arrive instead of crashing the tab, and it warns before a large download only where that is not possible, like in a private window.
- **server**: `S3_MEMORY_LIMIT` caps the memory that all uploads to S3 hold together, by default a quarter of the memory the server may use and at most 256MB, so many uploads at once slow down instead of running the server out of memory.

### 🐛 Bug Fixes

- **server**: Uploads to S3 storage no longer fail at the very end when their parts finished uploading out of order, which happened most often with several uploads at once.
- **server**: A failed or abandoned upload to S3 storage no longer leaves its uploaded parts in the bucket, where the provider kept billing them.
- **server**: Uploads to S3 storage that need more than 10,000 parts no longer fail, since the part size grows with the size of the upload.
- **web**: Uploads in chunks, the fallback when a WebSocket cannot connect, no longer fail in a Chrome incognito window once a file passes 1 to 2 GB.
- **web**: The technical info of a download no longer claims on a phone, a tablet or a browser other than Firefox that the developer tools are open.
- **web**: Several files that add up to more than 4 GB arrive as a zip that unzip tools can open, where they reported it as damaged before.
- **web**: Folders uploaded from Safari keep their subfolders in the zip, where files of the same name in two subfolders overwrote each other.
- **web**: Files whose names are too long together for the server are refused before the upload starts, instead of failing once every byte is up.
- **web**: A download in Firefox streams straight to disk again when the page sat open for half a minute before it started, instead of falling back to a slower way after five seconds.

### 🔒 Security

- **server**: Opening an upload over WebSocket counts against the rate limit like any other upload, and a connection that does not start its upload within 30 seconds is closed. Thanks @barnessomer ([GHSA-rmc2-p8pp-4vmh](https://github.com/Skyfay/SkySend/security/advisories/GHSA-rmc2-p8pp-4vmh))
- **server**: All uploads over WebSocket together hold at most `FILE_UPLOAD_WS_MEMORY_LIMIT` in memory and slow down once it is reached, so many uploads at once can no longer run the server out of memory. Thanks @barnessomer ([GHSA-rmc2-p8pp-4vmh](https://github.com/Skyfay/SkySend/security/advisories/GHSA-rmc2-p8pp-4vmh))

### 🎨 Improvements

- **crypto**: Encrypting and decrypting a file no longer slows down when the browser hands over the data in large pieces, which held back uploads from Chrome on Linux and downloads that are decrypted in memory.
- **web**: Uploads over WebSocket copy less and keep the connection busy, which makes them faster in every browser and about half again as fast in Chrome.
- **web**: The progress bar and the speed of an upload follow what really left the browser and change smoothly, instead of lagging behind and jumping at the end.
- **server**: An upload to S3 storage smaller than one part is stored with a single request, and the last part of a larger one goes out beside the parts still uploading.
- **server**: An upload over WebSocket stops as soon as writing to the storage fails, instead of after the browser sent the whole file.
- **web**: The download service worker only handles downloads and no longer sees every other request of the app, which also makes uploads in chunks faster.
- **server**: The files of the app are served from memory in one piece, so a page behind a reverse proxy on the same host no longer waits 200 to 400 ms for each of them.
- **web**: Several files go up while they are packed, with no wait before the upload and without the zip in memory, which made 3 GB of files that do not compress about four times as fast in a test.
- **web**: The technical info of a download names Brave as Brave and says why faster ways of saving were passed over, like a Service Worker stopped by a certificate error.

### 🔄 Changed

- **server**: `S3_PART_SIZE` and `S3_CONCURRENCY` default to 8MB and 8 instead of 25MB and 4, which keeps uploads to S3 steadier and needs less memory per upload.
- **web**: The zip of several files stores them without compression, which leaves most large files the same size and lets the upload start at once.
- **server**: `FILE_MAX_FILES_PER_UPLOAD` defaults to 200 instead of 32.

### 📝 Documentation

- **docs**: The S3 guide now explains how to set a lifecycle rule that removes incomplete multipart uploads.
- **docs**: The rate limiting guide explains that people behind one address share one count and when to raise `RATE_LIMIT_MAX`.

### 🧪 Tests

- **server**: Unit tests cover the order of the parts and the abort of S3 multipart uploads.
- **crypto**: Tests check the record layout of encrypted files against the format itself for every way the input can be cut into chunks.
- **infra**: A benchmark sends large files up and down through the app in Chromium, Chrome, Firefox and WebKit and records the speed of every hop, for one transfer or several side by side, optionally over a slower network or behind Nginx.
- **infra**: End-to-end tests check that the download service worker controls no page and replaces the registration of an older release.
- **server**: Unit tests cover the memory limit of S3 uploads and the serving of the files of the app.
- **infra**: An end-to-end test downloads a file through the browser's private storage, the way Safari now does, in Firefox with Service Workers blocked.
- **web**: Unit tests read the zip of several files back with another zip reader and check its records past 4 GB.
- **web**: Unit tests cover the check of the room in browser storage before a download goes there.
- **web**: Unit tests cover how the download service worker gets its updates and which worker takes a download.
- **server**: Unit tests cover the rate limit of uploads over WebSocket, their shared memory budget and the timeout before their start.
- **infra**: End-to-end tests check that a folder keeps its subfolders in the zip and that names too long for the server stop an upload before it starts.
- **infra**: An end-to-end test starts a download in Firefox after the browser stopped the idle download service worker.
