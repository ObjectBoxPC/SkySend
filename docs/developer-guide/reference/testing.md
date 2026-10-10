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
# Once: the three browsers and, on Linux, the system libraries they need (asks for sudo)
pnpm test:e2e:install

# Build the server and the SPA, then run every test in all three browsers
pnpm test:e2e

# Build, then pick tests and watch them run, step by step, at http://localhost:9323
pnpm test:e2e:ui

# The report of the last run, with screenshots, videos and traces of failed tests
pnpm --filter @skysend/e2e exec playwright show-report
```

The UI is a web page on `http://localhost:9323`. It needs a secure context for its Service Worker, so open it through `localhost`, not through the IP address or hostname of the machine. On a machine without a display, like a VM, use a browser on that machine or forward the port. The UI starts with the Chromium project only, the Projects filter at the top of the test list adds Firefox and WebKit.

### How a run works

The tests run against the production build, where the server serves the SPA and the API from one origin, the way an instance does. `e2e/scripts/serve.mjs` starts the server on an empty data directory in the system temp folder and puts a small recording proxy in front of it. The browsers talk to the proxy on port 3170, which passes everything on to the server on port 3171.

Two checks run in every test that downloads a file or opens a note:

- **Nothing secret reaches the server.** Each test names what only the sender and the recipient may know: the key from the link fragment, the filenames, passwords, note text and a stretch of each file. After the test, everything the proxy recorded is searched for them, in URLs, headers, request bodies and WebSocket frames. The search runs on the server side because Playwright does not see all traffic in every browser. `guard.spec.ts` makes sure the recording sees what a leak would look like.
- **The download takes the path meant for the browser.** Chromium and Firefox download through the Service Worker (tier 1), WebKit through the Blob fallback (tier 3), see [Download Modes](/developer-guide/download-modes). A tier that fails falls through to the next and the download still arrives, so the tests check the tier the app logged as well.

| File | Tests |
| --- | --- |
| `files.spec.ts` | A file byte for byte, several files as a zip, a password, a download limit |
| `notes.spec.ts` | A note of text, password and code blocks, a password, burn after reading |
| `requests.spec.ts` | Files into a request and out of the inbox, files and a note as one submission, an inbox with a password |
| `guard.spec.ts` | The recording of the proxy sees headers, bodies and WebSocket frames |

The **E2E Tests** job in `.github/workflows/validate.yml` runs them on every pull request. When it fails, the report with screenshots, videos and traces is attached to the run as the `e2e-report` artifact. A trace opens with `pnpm --filter @skysend/e2e exec playwright show-trace <trace.zip>`.

### Writing an end-to-end test

- Import `test` and `expect` from `./support/fixtures.js`, not from `@playwright/test`, so the guard runs.
- Tell the guard what has to stay secret: `guard.secretOf(link)`, `guard.requestLinks(uploadLink, inboxLink)` for a file request, `guard.text(...)` and `guard.content(name, data)`.
- Open the recipient with `openRecipient()`, a browser of its own without the IndexedDB and storage of the sender.
- Share and download through the helpers in `support/flows.ts`, and work with file requests through `support/requests.ts`. Generate the data with `randomFile`, `randomText` and `randomPassword`, so every value is unique and a hit cannot be a coincidence.
- Find elements by role and label, like a screen reader would. The browsers run with the `en-US` locale, so the labels are the English strings of the SPA.

WebKit on Linux is close to Safari but not the same. Behavior of Safari on an iPhone or iPad, like the early end of a Service Worker or the memory a large download takes, still needs a check on a real device.
