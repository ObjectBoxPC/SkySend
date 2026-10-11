import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { cli } from "./support/cli.js";
import { expect, test } from "./support/fixtures.js";
import {
  downloadFile,
  randomFile,
  randomPassword,
  randomText,
  shareFiles,
  unlock,
  watchTiers,
} from "./support/flows.js";

// The CLI and the browser encrypt with code of their own, the CLI with its own Argon2id too, so
// a share made by one has to open in the other. The CLI talks to the server through the same
// recording proxy, so the guard watches it like a browser.

test("a file the CLI uploads with a password opens in the browser", async ({
  page,
  baseURL,
  guard,
  expectedTier,
}, testInfo) => {
  const file = randomFile(200_000);
  const password = randomPassword();
  guard.text(file.name, password);
  guard.content(file.name, file.buffer);
  const path = testInfo.outputPath(file.name);
  await writeFile(path, file.buffer);

  const { url } = await cli(
    ["upload", path, "--server", baseURL!, "--password", password],
    testInfo.outputPath("home"),
  );
  const link = String(url);
  guard.secretOf(link);

  const tiers = watchTiers(page);
  await page.goto(link);
  await unlock(page, password);
  const received = await downloadFile(page);
  expect(received.name).toBe(file.name);
  expect(received.data.equals(file.buffer)).toBe(true);
  expect(tiers).toEqual([expectedTier]);
});

test("a file the browser shares with a password downloads with the CLI", async ({
  page,
  guard,
  browserName,
}, testInfo) => {
  test.skip(browserName !== "chromium", "The CLI does the downloading, any browser shares alike");
  const file = randomFile(200_000);
  const password = randomPassword();
  guard.text(file.name, password);
  guard.content(file.name, file.buffer);
  const link = await shareFiles(page, [file], { password });
  guard.secretOf(link);

  const output = testInfo.outputPath("downloads");
  await mkdir(output);
  const { file: saved } = await cli(
    ["download", link, "--output", output, "--password", password],
    testInfo.outputPath("home"),
  );
  expect(basename(String(saved))).toBe(file.name);
  expect((await readFile(String(saved))).equals(file.buffer)).toBe(true);
});

test("a note the CLI makes opens in the browser", async ({
  page,
  baseURL,
  guard,
  browserName,
}, testInfo) => {
  test.skip(browserName !== "chromium", "A note reads the same in every browser");
  const text = randomText("Written in a terminal");
  guard.text(text);

  const { url } = await cli(["note", text, "--server", baseURL!], testInfo.outputPath("home"));
  const link = String(url);
  guard.secretOf(link);

  await page.goto(link);
  await page.getByRole("button", { name: "View note" }).click();
  await expect(page.getByText(text)).toBeVisible();
});
