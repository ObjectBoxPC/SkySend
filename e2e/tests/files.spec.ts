import { unzipSync } from "fflate";
import { expect, test } from "./support/fixtures.js";
import {
  downloadFile,
  randomFile,
  randomPassword,
  shareFiles,
  unlock,
  watchTiers,
} from "./support/flows.js";

test("a file arrives byte for byte", async ({ page, openRecipient, guard, expectedTier }) => {
  // Many encryption records and WebSocket frames, with a short one at the end.
  const file = randomFile(3 * 1024 * 1024 + 4321);
  guard.text(file.name);
  guard.content(file.name, file.buffer);

  const link = await shareFiles(page, [file]);
  guard.secretOf(link);

  const recipient = await openRecipient();
  const tiers = watchTiers(recipient);
  await recipient.goto(link);
  const received = await downloadFile(recipient);

  expect(received.name).toBe(file.name);
  expect(received.data.equals(file.buffer)).toBe(true);
  expect(tiers).toEqual([expectedTier]);
});

test("several files arrive as one zip", async ({ page, openRecipient, guard, expectedTier }) => {
  const files = [randomFile(200_000), randomFile(70_000, "txt"), randomFile(1)];
  for (const file of files) {
    guard.text(file.name);
    guard.content(file.name, file.buffer);
  }

  const link = await shareFiles(page, files);
  guard.secretOf(link);

  const recipient = await openRecipient();
  const tiers = watchTiers(recipient);
  await recipient.goto(link);
  const received = await downloadFile(recipient);

  expect(received.name).toMatch(/\.zip$/);
  const entries = unzipSync(new Uint8Array(received.data));
  expect(Object.keys(entries).sort()).toEqual(files.map((file) => file.name).sort());
  for (const file of files) {
    expect(Buffer.from(entries[file.name]!).equals(file.buffer), file.name).toBe(true);
  }
  expect(tiers).toEqual([expectedTier]);
});

test("a password protects a file", async ({ page, openRecipient, guard, expectedTier }) => {
  const file = randomFile(300_000);
  const password = randomPassword();
  guard.text(file.name, password);
  guard.content(file.name, file.buffer);

  const link = await shareFiles(page, [file], { password });
  guard.secretOf(link);

  const recipient = await openRecipient();
  const tiers = watchTiers(recipient);
  await recipient.goto(link);
  await expect(recipient.getByText("This file is password-protected")).toBeVisible();
  await expect(recipient.getByText(file.name)).toHaveCount(0);

  await unlock(recipient, `${password}-wrong`);
  await expect(recipient.getByText("Incorrect password")).toBeVisible();

  await unlock(recipient, password);
  const received = await downloadFile(recipient);
  expect(received.name).toBe(file.name);
  expect(received.data.equals(file.buffer)).toBe(true);
  expect(tiers).toEqual([expectedTier]);
});

test("a file is gone once its downloads are used up", async ({ page, openRecipient, guard }) => {
  const file = randomFile(50_000);
  guard.text(file.name);

  const link = await shareFiles(page, [file], { downloads: 2 });
  guard.secretOf(link);

  for (let i = 0; i < 2; i++) {
    const recipient = await openRecipient();
    await recipient.goto(link);
    const received = await downloadFile(recipient);
    expect(received.data.equals(file.buffer)).toBe(true);
  }

  const late = await openRecipient();
  await late.goto(link);
  await expect(late.getByText("Download limit reached")).toBeVisible();
  await expect(late.getByRole("button", { name: "Download", exact: true })).toHaveCount(0);
});
