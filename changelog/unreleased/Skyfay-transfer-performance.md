### 🐛 Bug Fixes

- **server**: Uploads to S3 storage no longer fail at the very end when their parts finished uploading out of order, which happened most often with several uploads at once.
- **server**: A failed or abandoned upload to S3 storage no longer leaves its uploaded parts in the bucket, where the provider kept billing them.
- **server**: Uploads to S3 storage that need more than 10,000 parts no longer fail, since the part size grows with the size of the upload.

### 🎨 Improvements

- **crypto**: Encrypting and decrypting a file no longer slows down when the browser hands over the data in large pieces, which held back uploads from Chrome on Linux and downloads that are decrypted in memory.
- **web**: Uploads over WebSocket copy less and keep the connection busy, which makes them faster in every browser and about half again as fast in Chrome.
- **web**: The progress bar and the speed of an upload follow what really left the browser and change smoothly, instead of lagging behind and jumping at the end.
- **server**: An upload to S3 storage smaller than one part is stored with a single request, and the last part of a larger one goes out beside the parts still uploading.
- **server**: An upload over WebSocket stops as soon as writing to the storage fails, instead of after the browser sent the whole file.

### 🔄 Changed

- **server**: `S3_PART_SIZE` and `S3_CONCURRENCY` default to 8MB and 8 instead of 25MB and 4, which keeps uploads to S3 steadier and needs less memory per upload.

### 📝 Documentation

- **docs**: The S3 guide now explains how to set a lifecycle rule that removes incomplete multipart uploads.

### 🧪 Tests

- **server**: Unit tests cover the order of the parts and the abort of S3 multipart uploads.
- **crypto**: Tests check the record layout of encrypted files against the format itself for every way the input can be cut into chunks.
- **infra**: A benchmark sends large files up and down through the app in Chromium, Firefox and WebKit and records the speed of every hop, optionally over a slower network.
