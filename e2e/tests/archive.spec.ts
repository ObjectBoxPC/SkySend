import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { unzipSync } from "fflate";
import { expect, test } from "./support/fixtures.js";
import { downloadFile, randomFile, shareLink, watchTiers } from "./support/flows.js";

// App logic, so it runs in the direct setup only, never behind the proxies.

test("a folder arrives with its subfolders in the zip", async ({
  page,
  openRecipient,
  guard,
  expectedTier,
  browserName,
}) => {
  // Under Playwright, Firefox takes the folder but never answers the click after it, as if a
  // prompt held the page. Firefox keeps the paths of a File it posts to a worker anyway.
  test.skip(browserName === "firefox", "Firefox holds the page after a folder is picked");
  // Two files of the same name in two subfolders, which a zip without the paths would let
  // overwrite each other. WebKit drops the path of a File it posts to a worker.
  const folder = `e2e-folder-${randomBytes(6).toString("hex")}`;
  const same = randomFile(40_000);
  const other = randomFile(1_000, "txt");
  const files = [
    { path: `${folder}/first/${same.name}`, buffer: same.buffer },
    { path: `${folder}/second/${same.name}`, buffer: randomBytes(30_000) },
    { path: `${folder}/${other.name}`, buffer: other.buffer },
  ];
  guard.text(folder, same.name, other.name);
  for (const file of files) guard.content(file.path, file.buffer);

  const root = test.info().outputPath("picked");
  for (const file of files) {
    mkdirSync(join(root, file.path, ".."), { recursive: true });
    writeFileSync(join(root, file.path), file.buffer);
  }
  await page.goto("/");
  await page.locator("input[webkitdirectory]").setInputFiles(join(root, folder));
  await page.getByRole("button", { name: "Encrypt and upload" }).click();
  const link = await shareLink(page);
  guard.secretOf(link);

  const recipient = await openRecipient();
  const tiers = watchTiers(recipient);
  await recipient.goto(link);
  const received = await downloadFile(recipient);

  const entries = unzipSync(new Uint8Array(received.data));
  expect(Object.keys(entries).sort()).toEqual(files.map((file) => file.path).sort());
  for (const file of files) {
    expect(Buffer.from(entries[file.path]!).equals(file.buffer), file.path).toBe(true);
  }
  expect(tiers).toEqual([expectedTier]);
});

test("names too long together for the server stop an upload before it starts", async ({ page }) => {
  // 200 files fit the file limit, their names of 130 Japanese characters do not fit the
  // metadata the server takes, which it only gets once every byte is up.
  const files = Array.from({ length: 200 }, (_, i) => ({
    name: `${i}-${"日".repeat(130)}.bin`,
    mimeType: "application/octet-stream",
    buffer: Buffer.from([i]),
  }));
  await page.goto("/");
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(files);

  await expect(page.getByRole("alert")).toContainText("too long together for one upload");
  await expect(page.getByRole("button", { name: "Encrypt and upload" })).toBeDisabled();
});
