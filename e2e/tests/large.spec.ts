import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rm, stat, statfs } from "node:fs/promises";
import { expect, test } from "./support/fixtures.js";
import { readLink, watchTiers } from "./support/flows.js";

// Runs alone in the large-file setup, with `pnpm test:e2e:large`, see playwright.config.ts. The
// default of 5 GiB passes 2 GiB and 4 GiB, where a size overflows 32 bits. E2E_LARGE_SIZE takes
// another, in bytes. The file is written for the run and never kept: at its peak the server
// holds the ciphertext and the download sits beside it, about 11 GB on the disk of the checkout.

const SIZE = Number(process.env.E2E_LARGE_SIZE ?? 5 * 1024 ** 3);
const BLOCK = 1024 * 1024;

/**
 * Writes a file of `size` bytes whose every block differs, so a block swapped, repeated or lost
 * on the way would show, and returns its SHA-256. A file of zeros would hide all three.
 */
async function writeLargeFile(path: string, size: number) {
  const hash = createHash("sha256");
  const words = new Uint32Array(BLOCK / 4);
  const file = await open(path, "w");
  try {
    for (let offset = 0, block = 1; offset < size; offset += BLOCK, block++) {
      // xorshift32, seeded with the number of the block.
      let state = Math.imul(block, 0x9e3779b9) | 1;
      for (let index = 0; index < words.length; index++) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        words[index] = state;
      }
      const bytes = Buffer.from(words.buffer, 0, Math.min(BLOCK, size - offset));
      hash.update(bytes);
      await file.write(bytes);
    }
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

async function hashFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { highWaterMark: BLOCK })) hash.update(chunk);
  return hash.digest("hex");
}

/** Notes how long a step took, in the log of the run and in the report. */
function timed(step: string, since: number) {
  const seconds = (performance.now() - since) / 1000;
  const speed = SIZE / 1024 ** 2 / seconds;
  const note = `${seconds.toFixed(0)} s, ${speed.toFixed(0)} MiB/s`;
  console.log(`[large] ${step}: ${note}`);
  test.info().annotations.push({ type: step, description: note });
}

test("a file of several GiB goes up and comes down byte for byte", async ({
  page,
  openRecipient,
  guard,
  expectedTier,
}, testInfo) => {
  test.setTimeout(60 * 60_000);
  const name = `e2e-large-${randomBytes(4).toString("hex")}.bin`;
  const source = testInfo.outputPath(name);
  // The server data and the download sit in e2e/.large-files, on the same disk as the source.
  const { bavail, bsize } = await statfs(testInfo.outputDir);
  const needed = 2.2 * SIZE;
  const message = `needs ${(needed / 1e9).toFixed(1)} GB of free disk beside ${testInfo.outputDir}`;
  expect(bavail * bsize, message).toBeGreaterThan(needed);
  let since = performance.now();
  const expected = await writeLargeFile(source, SIZE);
  timed("write", since);
  // The setup records headers only, where a key or a name would leak, not the content.
  guard.text(name);

  await page.goto("/");
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(source);
  since = performance.now();
  await page.getByRole("button", { name: "Encrypt and upload" }).click();
  const link = await readLink(page, "Share this link", 30 * 60_000);
  timed("upload", since);
  guard.secretOf(link);
  // The server holds the ciphertext now. Without the source, the download fits beside it.
  await rm(source);

  const recipient = await openRecipient();
  const tiers = watchTiers(recipient);
  await recipient.goto(link);
  since = performance.now();
  const started = recipient.waitForEvent("download");
  await recipient.getByRole("button", { name: "Download", exact: true }).click();
  const download = await started;
  const path = await download.path();
  timed("download", since);

  try {
    expect(download.suggestedFilename()).toBe(name);
    expect((await stat(path)).size).toBe(SIZE);
    expect(await hashFile(path), "the download matches the upload byte for byte").toBe(expected);
    expect(tiers).toEqual([expectedTier]);
  } finally {
    await download.delete();
  }
});
