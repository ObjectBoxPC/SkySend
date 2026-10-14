### 🐛 Bug Fixes

- **server**: A chunk the server refuses as too large no longer leaves its file behind in the data directory now and then.

### 🧪 Tests

- **server**: A unit test checks that a refused chunk leaves no file behind, also on a disk that opens files slowly.
