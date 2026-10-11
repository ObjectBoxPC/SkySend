# Testing Guide

SkySend uses [Vitest](https://vitest.dev/) for unit and integration testing and [Playwright](https://playwright.dev/) for end-to-end tests in Chromium, Firefox and WebKit. See [End-to-End Tests](#end-to-end-tests).

## Running Tests

```bash
# Run all tests
pnpm test

# Run tests for a specific package
cd packages/crypto && pnpm test
cd apps/server && pnpm test
```

## Test Structure

### Crypto Tests (`packages/crypto/tests/`)

| File | Tests |
| --- | --- |
| `keychain.test.ts` | Secret/salt generation, HKDF key derivation, token computation |
| `ece.test.ts` | Streaming encryption/decryption, nonce handling, size calculation |
| `metadata.test.ts` | Metadata encryption/decryption, schema validation |
| `password.test.ts` | Argon2id key derivation, password protection XOR |
| `util.test.ts` | Base64url encoding, constant-time comparison, byte utilities |
| `integration.test.ts` | Full encrypt-decrypt roundtrip |

### Server Tests (`apps/server/tests/`)

| File | Tests |
| --- | --- |
| `routes.test.ts` | All API route handlers |
| `db.test.ts` | Database operations |
| `storage.test.ts` | Filesystem storage layer |
| `cleanup.test.ts` | Expired upload cleanup |
| `config.test.ts` | Environment variable parsing and validation |
| `rate-limit.test.ts` | Rate limiter behavior |
| `quota.test.ts` | Upload quota enforcement |

## Writing Tests

### Conventions

- Test files are named `*.test.ts`
- Tests are placed in a `tests/` directory next to the source
- Use `describe` blocks to group related tests
- Use `it` or `test` for individual test cases
- Prefer `expect` assertions

### Example

```typescript
import { describe, it, expect } from 'vitest'
import { generateSecret, SALT_LENGTH } from '@skysend/crypto'

describe('generateSecret', () => {
  it('should generate 32 bytes', () => {
    const secret = generateSecret()
    expect(secret).toBeInstanceOf(Uint8Array)
    expect(secret.byteLength).toBe(32)
  })

  it('should generate unique values', () => {
    const a = generateSecret()
    const b = generateSecret()
    expect(a).not.toEqual(b)
  })
})
```

## Test Helpers

The server tests use a shared `helpers.ts` file that provides:

- Test database setup/teardown
- Pre-configured Hono app instances
- Helper functions for creating test uploads

## End-to-End Tests

The end-to-end tests in `e2e/` drive the real app in Chromium, Firefox and WebKit, the way a person would: share a file or a note, open the link in a second browser that knows nothing of the sender, download or read it and compare it with what was shared.

```bash
# Once: the three browsers, on Linux the system libraries they need (asks for sudo), and Caddy
pnpm test:e2e:install

# Build the server and the SPA, then run every test in all three browsers and every setup
pnpm test:e2e

# Build, then pick tests and watch them run, step by step, at http://localhost:9323
pnpm test:e2e:ui

# The report of the last run, with screenshots, videos and traces of failed tests
pnpm --filter @skysend/e2e exec playwright show-report
```

The UI is a web page on `http://localhost:9323`. It needs a secure context for its Service Worker, so open it through `localhost`, not through the IP address or hostname of the machine. On a machine without a display, like a VM, use a browser on that machine or forward the port. The UI starts with the `chromium` project only, the Projects filter at the top of the test list adds the others.

### How a run works

The tests run against the production build, where the server serves the SPA and the API from one origin, the way an instance does. `e2e/scripts/serve.mjs` starts a server on an empty data directory in the system temp folder and puts a small recording proxy in front of it, which passes everything on to the server one port above.

Each setup is a server of its own. The direct one runs every test of the app in all three browsers. The setups behind a reverse proxy run what goes over the wire: files, file requests, links and transports, plus the notes behind Caddy and the guard wherever there is a WebSocket.

| Setup | Projects | Browser to SkySend | Uploads |
| --- | --- | --- | --- |
| direct | `chromium`, `firefox`, `webkit` | HTTP/1.1 to `http://localhost:3170` | WebSocket |
| behind Caddy | `chromium-caddy`, ... | HTTPS and HTTP/2 to `https://localhost:3443` | WebSocket, upgraded through Caddy |
| behind Caddy, chunks | `chromium-caddy-chunks`, ... | HTTPS and HTTP/2 to `https://localhost:3444` | Chunks over HTTP/2, `FILE_UPLOAD_WS=false` |
| behind Nginx | `chromium-nginx`, ... | HTTPS and HTTP/2 to `https://localhost:3445` | WebSocket, upgraded through Nginx |
| behind Nginx, chunks | `chromium-nginx-chunks`, ... | HTTPS and HTTP/2 to `https://localhost:3446` | Chunks over HTTP/2, `FILE_UPLOAD_WS=false` |

A few more setups each change one setting of the server and run their part of `config.spec.ts` in Chromium only, since a server setting acts the same in every browser: `forced-passwords` with `FORCE_FILE_PASSWORD`, `FORCE_NOTE_PASSWORD` and `FORCE_REQUEST_PASSWORD`, `files-only`, `notes-only` and `requests-only` with `ENABLED_SERVICES`, and `slow-uploads` with `FILE_UPLOAD_SPEED_LIMIT`, slow enough to cancel an upload halfway. The direct server also offers an expiry of 5 seconds next to the defaults, for `expiry.spec.ts`.

Two setups bring a service of their own:

- **`s3`** keeps the ciphertext in an S3 store, SeaweedFS in Docker, pinned by digest, since MinIO no longer publishes images. Downloads then come from the bucket through presigned URLs, which the file and request tests check, in Chromium for the Service Worker and in WebKit for the page.
- **`oidc`** puts uploads behind a login with `OIDC_PROTECT_FILES` and `OIDC_PROTECT_NOTES`. `e2e/scripts/oidc.mjs` runs a test provider with [oidc-provider](https://github.com/panva/node-oidc-provider) over HTTPS with a certificate of its own, since the server only accepts an issuer over HTTPS. Only this server of the tests skips the certificate check, through `NODE_TLS_REJECT_UNAUTHORIZED=0`.

A run never reuses a server it finds running, since that one would answer with its old configuration. A taken port fails the run instead. To run next to an open UI mode, shift every port, data directory and container: `E2E_PORT_OFFSET=1000 pnpm test:e2e`.

Uploads that stalled behind reverse proxies, like the HTTP/2 problems fixed in v2.2.2 and v2.2.3, only show up when a proxy speaks HTTP/2 to the browser. Both proxies are set up the way [Reverse Proxy](/user-guide/self-hosting/reverse-proxy) tells operators to, with a certificate of their own that the browsers are told to accept:

- **Caddy** gets nothing but the `reverse_proxy` line per site, see `e2e/proxies/Caddyfile`. `pnpm test:e2e:install` downloads it into `e2e/.tools/` and checks it against a pinned SHA-512.
- **Nginx** runs the example of the docs page itself. `e2e/scripts/nginx.mjs` reads the `nginx` block out of `reverse-proxy.md` on every start and only replaces the port, the certificate and the upstream, so a change to that example is tested by the next run. It runs the official Nginx image, pinned by digest, on the host network, which takes Docker, and on a Mac the host networking of Docker Desktop.

Without Caddy or Docker, a local run leaves out the setups behind them and says so. CI fails instead.

Three checks run wherever a test shares, uploads or downloads:

- **Nothing secret reaches the server.** Each test names what only the sender and the recipient may know: the key from the link fragment, the filenames, passwords, note text and a stretch of each file. After the test, everything the proxy recorded is searched for them, in URLs, headers, request bodies and WebSocket frames. The search runs on the server side because Playwright does not see all traffic in every browser. `guard.spec.ts` makes sure the recording sees what a leak would look like.
- **The download takes the path meant for the browser.** Chromium and Firefox download through the Service Worker (tier 1), WebKit through the Blob fallback (tier 3), see [Download Modes](/developer-guide/download-modes). A tier that fails falls through to the next and the download still arrives, so the tests check the tier the app logged as well.
- **Uploads take the transport of the setup.** A broken WebSocket would fall back to chunks without a word, so every upload has to log the transport its setup offers.

| File | Tests |
| --- | --- |
| `files.spec.ts` | A file byte for byte, one of 32 MB in several chunks, several files as a zip, a password, a download limit |
| `notes.spec.ts` | A note of text, password and code blocks, a password, burn after reading |
| `requests.spec.ts` | Files into a request and out of the inbox, files and a note as one submission, an inbox with a password |
| `request-lifecycle.spec.ts` | A closed request and a full one turn senders away, an inbox deletes one file and then the request |
| `links.spec.ts` | A `/d/` link of v1, and links a mail filter rewrote, which open and warn that the key reached the server |
| `expiry.spec.ts` | A file, a note and a request stop working once their time runs out |
| `my-links.spec.ts` | Shares and requests show in My Links, open from there and are deleted there |
| `templates.spec.ts` | A template saved from the form starts a request, a sealed templates link moves one to another browser |
| `mobile.spec.ts` | Sharing through the sheets of a phone screen, and no page wider than the screen |
| `config.spec.ts` | Forced passwords, a single enabled service, a cancelled upload, sharing behind an OIDC login |
| `cli.spec.ts` | The CLI and the browser open each other's shares, with a password both ways, and a note made in the CLI |
| `guard.spec.ts` | The recording of the proxy sees headers, bodies and WebSocket frames |
| `transport.spec.ts` | The page arrives over HTTP/1.1 or HTTP/2 as its setup promises, and an upload takes its transport |
| `compat.spec.ts` | Every link of an older release still opens after an update, see below |

The **E2E Tests** job in `.github/workflows/validate.yml` runs them on every pull request. When it fails, the report with screenshots, videos and traces is attached to the run as the `e2e-report` artifact. A trace opens with `pnpm --filter @skysend/e2e exec playwright show-trace <trace.zip>`.

### Links from older releases

An update must not break the links an instance handed out before it. `compat.spec.ts` checks that for every release with a snapshot in `e2e/compat/snapshots/<version>/`:

- `data.tar.gz` holds the data directory and the uploads of a server of that release, right after it shared files, notes and file requests through its own UI.
- `links.json` lists what was shared: the links with their keys, the passwords, the names, and the seeds the file contents are made from, so the snapshot does not have to keep the original files.

A run starts the current server on a copy of each snapshot, moves every expiry a year ahead and lets the server migrate the database the way it does after an update. Then every link is opened in all three browsers. Files are downloaded and compared byte for byte, notes and inboxes are opened, and a request made before the update takes a new upload.

A snapshot is made once and committed. After a release, run:

```bash
pnpm --filter @skysend/e2e compat:seed v3.0.2
```

It starts the published image of that version with Docker, shares through its UI with `e2e/compat/seed/release.spec.ts`, and writes the snapshot. A release whose UI the current test helpers no longer fit gets a seed of its own, `e2e/compat/seed/<version>.spec.ts`, written against that UI.

### Writing an end-to-end test

- Import `test` and `expect` from `./support/fixtures.js`, not from `@playwright/test`, so the guard runs.
- Tell the guard what has to stay secret: `guard.secretOf(link)`, `guard.requestLinks(uploadLink, inboxLink)` for a file request, `guard.text(...)` and `guard.content(name, data)`.
- Open the recipient with `openRecipient()`, a browser of its own without the IndexedDB and storage of the sender.
- Share and download through the helpers in `support/flows.ts`, and work with file requests through `support/requests.ts`. Generate the data with `randomFile`, `randomText` and `randomPassword`, so every value is unique and a hit cannot be a coincidence.
- Find elements by role and label, like a screen reader would. The browsers run with the `en-US` locale, so the labels are the English strings of the SPA.

WebKit on Linux is close to Safari but not the same. Behavior of Safari on an iPhone or iPad, like the early end of a Service Worker or the memory a large download takes, still needs a check on a real device.
