### 📝 Documentation

- **docs**: The testing guide explains how to run and write the end-to-end tests.
- **docs**: Troubleshooting explains why Chrome asks where to save every download on an instance whose certificate it does not trust.

### 🧪 Tests

- **infra**: End-to-end tests share files and notes and send to file requests in Chromium, Firefox and WebKit, directly and behind Caddy and Nginx with HTTPS and HTTP/2, then open them on the other side. They check that keys, filenames, passwords and contents never reach the server and that uploads and downloads take the path they should.
- **infra**: The Nginx example of the reverse proxy guide runs in the end-to-end tests as written, so a change that breaks it fails its pull request.
- **infra**: The end-to-end tests open the links of v3.0.1 with the current version after it migrated that release's data, so a change that breaks old links fails its pull request.

### 🔧 CI/CD

- **infra**: Pull requests run the end-to-end tests in a job of their own, which keeps the screenshots, videos and traces of a failed run for seven days.
