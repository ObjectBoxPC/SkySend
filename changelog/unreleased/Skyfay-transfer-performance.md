### 🐛 Bug Fixes

- **server**: Uploads to S3 storage no longer fail at the very end when their parts finished uploading out of order, which happened most often with several uploads at once.
- **server**: A failed or abandoned upload to S3 storage no longer leaves its uploaded parts in the bucket, where the provider kept billing them.

### 📝 Documentation

- **docs**: The S3 guide now explains how to set a lifecycle rule that removes incomplete multipart uploads.

### 🧪 Tests

- **server**: Unit tests cover the order of the parts and the abort of S3 multipart uploads.
- **infra**: A benchmark sends large files up and down through the app in Chromium, Firefox and WebKit and records the speed of every hop, optionally over a slower network.
