### 📝 Documentation

- **docs**: The testing guide explains how to run and write the end-to-end tests.
- **docs**: Troubleshooting explains why Chrome asks where to save every download on an instance whose certificate it does not trust.
- **docs**: The AI transparency section of the README names the end-to-end tests among the checks behind the code.

### 🧪 Tests

- **infra**: End-to-end tests share files and notes and send to file requests in Chromium, Firefox and WebKit, directly and behind Caddy and Nginx with HTTPS and HTTP/2, then open them on the other side. They check that keys, filenames, passwords and contents never reach the server and that uploads and downloads take the path they should.
- **infra**: The Nginx example of the reverse proxy guide runs in the end-to-end tests as written, so a change that breaks it fails its pull request.
- **infra**: The end-to-end tests also cover My Links, closing, filling and deleting file requests, request templates, expiry by time, rewritten links and links of v1, uploads in several chunks, a cancelled upload, the phone layout and the settings for forced passwords and enabled services. They also run against S3 storage, behind an OIDC login and with shares between the CLI and the browser.
- **infra**: The end-to-end tests open the links of v3.0.1 with the current version after it migrated that release's data, so a change that breaks old links fails its pull request.
- **web**: Unit tests feed every block of a note the markup an attacker would try and check that nothing of it can run, load or restyle the page.
- **infra**: An end-to-end test opens a crafted note in Chromium, Firefox and WebKit and checks the rendered page for anything that could run.

### 🔧 CI/CD

- **infra**: Pull requests run the end-to-end tests in one job per browser, each starting only the services its tests need, and keep the screenshots, videos and traces of a failed job for seven days.
- **infra**: A job of its own sends a file of 5 GiB up through Nginx with TLS and HTTP/2 and down again in Chromium, and compares it byte for byte.
- **infra**: A pull request into dev that changes nothing the end-to-end tests cover, like one for the website alone, skips them, and Validate can also be started by hand.
