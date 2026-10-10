# End-to-end tests

Playwright drives the production build in Chromium, Firefox and WebKit. Package name `@skysend/e2e`, versioned on its own like the Workers, so `version:sync` leaves it alone. The long-form guide for people is `docs/developer-guide/reference/testing.md`, keep both in step.

```bash
pnpm test:e2e:install                                  # Browsers, apt libraries on Linux (sudo), Caddy into e2e/.tools
pnpm test:e2e                                          # Builds crypto, note-format, server and web, then runs everything
pnpm test:e2e:ui                                       # Builds, then the Playwright UI at http://localhost:9323
```

The UI is served as a page instead of a window, so it works on a machine without a display. Its Service Worker needs a secure context: it only renders through `localhost`, an IP address or hostname shows a black page. It starts with the Chromium project selected.

`pnpm test` and `pnpm validate` do not run these. CI runs them in the **E2E Tests** job of `validate.yml`.

## How a run is wired

- `scripts/serve.mjs` wipes `DATA_DIR`, imports `apps/server/dist/index.js` and puts a recording proxy in front of it, on `PROXY_PORT` with the server one port above. `BASE_URL` is the origin the browser opens, so CORS and the WebSocket origin check pass. The proxy copies the server's connection timeouts (keep-alive 120 s), so Caddy and Nginx meet the same backend they would meet without it.
- `TARGETS` in `playwright.config.ts` starts one such server per setup, each with its own `skysend-e2e-<name>` data directory in the temp folder: `direct` (HTTP/1.1, 3170), `caddy` (HTTPS and HTTP/2 on 3443, recording proxy 3270), `caddy-chunks` (3444 and 3370, `FILE_UPLOAD_WS=false`), `nginx` (3445 and 3470) and `nginx-chunks` (3446 and 3570). Proxy files live in `<tmpdir>/skysend-e2e-proxy-<name>`, apart from the data directories the servers wipe. Projects are `<engine>` for direct and `<engine>-<setup>` for the rest. A new server setting to test is a new target, not a branch in a test.
- `proxies/Caddyfile` keeps each site to the bare `reverse_proxy` line of the published docs. The global block only keeps Caddy local: its own CA, `skip_install_trust`, storage in the temp folder, bound to 127.0.0.1, no port 80 redirect, HTTP/3 off so the protocol does not depend on timing.
- `scripts/install-caddy.mjs` pins Caddy's version and the SHA-512 of each archive. Raising the version means new hashes from the release's checksums file. Without the binary, a local run drops the Caddy targets with a warning and CI throws.
- `scripts/nginx.mjs <name> <port> <upstream>` reads the `nginx` block of `docs/user-guide/self-hosting/reverse-proxy.md` on every start, drops the port 80 redirect and replaces the `listen`, the two certificate lines and `proxy_pass`, each of which has to match exactly once. A reworded example fails there on purpose, adjust the patterns with the docs. It runs `nginx:1.30.5-alpine` pinned by digest with `--network host` and a fresh self-signed certificate, and removes the container on SIGTERM. Without a working `docker info`, a local run drops the Nginx targets and CI throws.
- Known flake, as of 2026-10: WebKit on Linux sometimes never answers the very first navigation of a fresh context to an HTTPS setup, about once in 160 tests, and only in full runs under load. Nothing reaches the proxy or the server, Chromium and Firefox never do it, and Safari's network stack is a different one. CI retries once, so it shows as flaky. Do not paper over it with a navigation retry in the helpers.
- Nginx 1.25.1 and later warn that `listen ... http2` from the docs is deprecated. The docs keep it on purpose: `http2 on;` breaks the Nginx 1.24 of Ubuntu 24.04 and older.
- Chromium refuses a Service Worker from an origin with a certificate error even with `ignoreHTTPSErrors`, and falls through to the file picker, which hangs. The Chromium projects behind Caddy launch with `--ignore-certificate-errors` for that.
- The proxy records every request line, header, body and unmasked client WebSocket frame, and answers `POST /__e2e__/scan` with the needles it finds. It strips `Sec-WebSocket-Extensions` so frames stay uncompressed.
- The recording sits on the server side on purpose. Playwright misses Service Worker requests in Firefox and WebSocket frames in WebKit, so a check built on `page.on("request")` passes where a leak happened.
- `CLEANUP_INTERVAL` is a day, so a share that ran out shows "limit reached" instead of vanishing mid-test. The rate limit, the quota and the daily request limit are lifted, since every test comes from one address.

## Writing tests

- Import `test` and `expect` from `./support/fixtures.js`. Its `guard` fixture is automatic and fails a test when any needle reached the server.
- Feed the guard everything secret: `guard.secretOf(link)` (base64url, base64, hex and raw bytes of the key), `guard.text(...)`, `guard.content(name, data)`. Content under 32 bytes is skipped, a one-byte needle matches everywhere.
- A file request has two links. `guard.requestLinks(uploadLink, inboxLink)` adds both fragments and, decoded with the real decoders of `@skysend/crypto`, the link secret and the inbox secret on their own. The public key of the upload link is no secret and stays out.
- File request flows live in `support/requests.ts`. Uploads sent together sit in a nested list, so `inboxRow` picks the innermost list item.
- Generate data with `randomFile`, `randomText`, `randomPassword` from `support/flows.ts`. A fixed string could appear by chance.
- The recipient is `openRecipient()`, a fresh context. Never reuse the sender's page, its IndexedDB holds the link.
- Every download goes through `watchTiers(page)` and asserts `expect(tiers).toEqual([expectedTier])`: tier 1 in Chromium and Firefox, tier 3 in WebKit. A broken tier falls through and the file still arrives, only this assertion notices.
- The automatic `uploadTransports` fixture collects the transport the upload worker logs in every context of a test, including recipients, and fails when one differs from the target's `uploadTransport` option. `transport.spec.ts` asserts the protocol (`nextHopProtocol`) and that an upload logs a transport at all.
- The app has no test ids. Select by role and the English label (`locale: "en-US"`). The option pills open a `radiogroup`, not a `group`.
- A WebSocket the server rejects drops whatever the browser had not sent yet in WebKit. Send one message per socket when a test needs frames on the wire.

## Snapshots of releases

`compat/snapshots/<version>/` holds `data.tar.gz` (the `data/` and `uploads/` of a server of that release, `data/tmp` left out) and `links.json` (what was shared). Every snapshot becomes a target `compat-<version>` on port 3670 plus 100 per version, whose projects run only `compat.spec.ts` and pick their release's tests by the `[version]` in the title through `grep`.

- `compat/seed.mjs <version>` (`pnpm --filter @skysend/e2e compat:seed`) runs the published `ghcr.io/skyfay/skysend:<version>` with Docker as the current user, shares through its UI with `seed/<version>.spec.ts` or `seed/release.spec.ts`, stops it with SIGTERM so SQLite checkpoints, and packs the result. Make a snapshot once, right after its release, and commit it. Seeding again replaces every key, so never reseed an existing version without a reason.
- `release.spec.ts` uses the current helpers, which fit the release just made. A release with an older UI needs its own seed. Version-specific seeds may break later as the helpers move on, which is fine, they ran once.
- The seed server gets high limits (1000 downloads, unlimited views, 1000 uploads and 100 downloads per request, the most v3.0.1 accepts), since all three engines and their retries share one copy of the snapshot. Inbox and file tests find rows by name, never by count, because the open-request test adds uploads.
- `scripts/serve.mjs` restores a snapshot when `SNAPSHOT` is set: unpacks it, points `DATA_DIR` and `UPLOADS_DIR` at it, and sets every `expires_at` and `closes_at` column of every table a year ahead (seconds or milliseconds, by size) before the server starts and migrates. That works on any schema, so a new snapshot needs no code there. `storage_path` holds `<id>.bin`, relative, so the uploads can move.
- `links.json` keeps path and fragment only, the origin differs per run. File contents come from `compatBytes(file)`, a SHA-256 stream of the file's seed.
- A snapshot made right after its release has the same migrations as the current server. Migrations only get exercised once the schema moves on, or by a snapshot of an older release.

## Checking a check

A new assertion is only worth something if it can fail. Break the thing it guards once and put it back: move `apps/web/dist/download-sw.js` away, which must fail the tier assertion, or give a Caddy site a `request_body { max_size 1MB }`, which must fail the uploads of `caddy-chunks`, or let `extendExpiries` in `scripts/serve.mjs` move the dates a minute into the past, which must fail every compat test.
