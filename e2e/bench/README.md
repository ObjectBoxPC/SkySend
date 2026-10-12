# Transfer benchmark

Measures large uploads and downloads through the real app in a real browser. Not a test: it fails only when a transfer fails or a file comes back different. The guide is the "Measuring uploads and downloads" section of `docs/developer-guide/reference/testing.md`.

Build first with `pnpm test:e2e:build`. Everything a run writes stays in `e2e/.large-files/bench/`, which git ignores: the source files (kept between runs, one per size), the server data and the downloads (removed after a run), and one JSON file per run in `results/`.

## transfer.mjs

```
browser --> [proxy A :3900] --> server :3901 --> [proxy B :3902] --> S3 :3903
```

| Option | Default | What it does |
| :--- | :--- | :--- |
| `--browser` | `chromium` | `chromium`, `firefox` or `webkit` |
| `--channel` | `chromium` for Chromium | The full Chromium in its new headless mode, which is what people run. `shell` takes the headless shell of the end-to-end tests. |
| `--storage` | `fs` | `fs` or `s3` |
| `--s3` | `local` | `local` starts SeaweedFS in Docker, or an `http://host:port` of a store that takes unsigned requests, like SeaweedFS without identities |
| `--transport` | `ws` | `ws` or `http`, through `FILE_UPLOAD_WS` |
| `--size` | `1024` | MiB |
| `--env KEY=VALUE` | | Any server variable, repeatable, like `--env S3_PART_SIZE=10MB` |
| `--parallel N` | `1` | N senders upload at once, nothing is downloaded |
| `--cancel-after S` | | Closes the sender S seconds into the upload |
| `--no-download` | | Upload only |
| `--no-verify` | | Skips the SHA-256 of the download |
| `--profile` | | Writes a CPU profile of the server to `profiles/` |
| `--label` | from the options | Name of the result file |
| `--proxy nginx` | | Puts the Nginx of the reverse proxy guide in front, in Docker, with TLS and HTTP/2 on port 3906, the way an instance runs |
| `--port` | `3900` | First of the four ports |

What a result holds: total time and speed per direction, the time from the click to the first byte and from 100 % in the UI to the link (`tailSeconds`), rates in windows of 250 ms, 500 ms and 1 s with their spread (`cv`) for the UI, the wire and the bucket, CPU and peak memory of server and browser, the download tier, whether the download matched, and with S3 the multipart uploads left in the bucket.

## summary.mjs

`node e2e/bench/summary.mjs [--last 5] [result.json ...]` prints one line per run: speed, total, startup and tail time, the spread of UI, wire and bucket, the download, server memory and CPU, and what was left in the bucket.

## timeline.mjs

`node e2e/bench/timeline.mjs [result.json] [--step 500]` prints a result as a table over time. Without a file it takes the newest.

## shape.sh

`sudo e2e/bench/shape.sh apply <client rate> <client delay> <s3 rate> <s3 delay>` gives the hop to the server and the hop to the bucket a rate and a delay each way with `tc netem` on the loopback device, matched by port, so nothing else on the machine slows down. `none` leaves a hop as it is, a delay like `"15ms 10ms"` adds jitter. `clear` removes it, `show` prints it.

## pipeline.mjs

`node e2e/bench/pipeline.mjs [--browser chromium] [--size 1024] [--only read,encrypt,encrypt-64k,raw,ws-plain,ws-encrypt,ws-encrypt-64k,ws2-plain,ws2-encrypt,post,post-plain,post-encrypt]` measures the stages of the browser one by one in a Web Worker, on a page of its own without the app. It needs a source file of that size, which `transfer.mjs` writes. `ws-*` is the send loop of the app before 2026-10, `ws2-*` the one it has now, `*-64k` cuts the file into the chunks Firefox reads before encrypting. `--sw` registers a Service Worker shaped like `download-sw.js` first, `--routes` gives it static routes that send every other request to the network, and `--persistent` uses a normal profile instead of an incognito one.

## pageload.mjs

`node e2e/bench/pageload.mjs <url> [browser]` lists every request of a page load with its timing.

## ece.mjs

`node e2e/bench/ece.mjs [--size 256] [--chunks 64K,1M,8M,32M]` measures `createEncryptStream` and `createDecryptStream` in Node, fed with chunks of one size each. Browsers hand out very different ones: Firefox reads a file in 64 KiB, Chromium in up to 2 MiB, and a fetch body can arrive in pieces of many MiB.
