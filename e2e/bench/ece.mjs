// Measures createEncryptStream and createDecryptStream of @skysend/crypto in Node, fed with
// chunks of one size, since browsers hand out very different ones: Firefox reads a file in
// 64 KiB, Chromium in up to 2 MiB, and a fetch body can arrive in pieces of many MiB.
//
//   node e2e/bench/ece.mjs [--size 256] [--chunks 64K,1M,8M,32M]
//
// Build @skysend/crypto first.
import { join } from "node:path";
import { parseArgs } from "node:util";

const ROOT = join(import.meta.dirname, "..", "..");
const { createEncryptStream, createDecryptStream, deriveKeys, generateSecret, generateSalt } =
  await import(join(ROOT, "packages", "crypto", "dist", "index.js"));

const { values: opts } = parseArgs({
  options: {
    size: { type: "string", default: "256" },
    chunks: { type: "string", default: "64K,1M,8M,32M" },
  },
});
const MIB = 1024 * 1024;
const SIZE = Number(opts.size) * MIB;
const parseSize = (text) =>
  Number.parseFloat(text) * (/M$/i.test(text) ? MIB : /K$/i.test(text) ? 1024 : 1);

/** A stream of `total` bytes in chunks of `chunk` bytes, all views of one buffer. */
function source(data, chunk) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= data.byteLength) return controller.close();
      controller.enqueue(data.subarray(offset, offset + chunk));
      offset += chunk;
    },
  });
}

async function collect(stream) {
  const parts = [];
  let size = 0;
  for await (const part of stream) {
    parts.push(part);
    size += part.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const { fileKey } = await deriveKeys(generateSecret(), generateSalt());
const plain = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i += 65536) crypto.getRandomValues(plain.subarray(i, i + 65536));
const cipher = await collect(source(plain, MIB).pipeThrough(createEncryptStream(fileKey)));

console.log(`${opts.size} MiB, Node ${process.version}`);
for (const text of opts.chunks.split(",")) {
  const chunk = parseSize(text);
  let start = performance.now();
  await collect(source(plain, chunk).pipeThrough(createEncryptStream(fileKey)));
  const encrypt = SIZE / MIB / ((performance.now() - start) / 1000);
  start = performance.now();
  const back = await collect(source(cipher, chunk).pipeThrough(createDecryptStream(fileKey, SIZE)));
  const decrypt = SIZE / MIB / ((performance.now() - start) / 1000);
  if (back.byteLength !== SIZE) throw new Error("The round trip lost bytes");
  console.log(
    `chunks of ${text.padEnd(4)} encrypt ${encrypt.toFixed(0).padStart(6)} MiB/s   decrypt ${decrypt.toFixed(0).padStart(6)} MiB/s`,
  );
}
