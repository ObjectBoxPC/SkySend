import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";

/** A file to share, with a name nobody else uses, so a leak of it cannot be a coincidence. */
export function randomFile(size: number, extension = "bin") {
  return {
    name: `e2e-${randomBytes(6).toString("hex")}.${extension}`,
    mimeType: "application/octet-stream",
    buffer: randomBytes(size),
  };
}

export type SharedFile = ReturnType<typeof randomFile>;

/** A password that passes the minimum and appears nowhere else. */
export function randomPassword() {
  return `pw-${randomBytes(9).toString("base64url")}`;
}

/** Text that appears nowhere else. */
export function randomText(label: string) {
  return `${label} ${randomBytes(9).toString("base64url")}`;
}

/** Opens the options of a pill like "1 download" and picks one of them. */
export async function pick(page: Page, pill: RegExp, question: string, option: string) {
  await page.getByRole("button", { name: pill }).click();
  await page
    .getByRole("radiogroup", { name: question })
    .getByRole("radio", { name: option, exact: true })
    .click();
}

/** Picks how long a file or note link works, by the label of its option, like "5s". */
async function pickExpiry(page: Page, expiry: string) {
  await pick(page, /^Expires after/, "How long should the link work?", expiry);
}

/** Switches the password of a share or a request on and types it. */
export async function setPassword(page: Page, password: string) {
  await page.getByRole("switch", { name: "Password" }).click();
  await page.getByPlaceholder("Enter password (optional)").fill(password);
}

/** A link the app shows once it is ready, like "Share this link" of a finished share. */
export async function readLink(page: Page, label: string) {
  const link = page.getByLabel(label, { exact: true });
  await expect(link).toBeVisible({ timeout: 30_000 });
  return (await link.textContent()) ?? "";
}

async function shareLink(page: Page) {
  return readLink(page, "Share this link");
}

export async function shareFiles(
  page: Page,
  files: SharedFile[],
  options: { downloads?: number; password?: string; expiry?: string } = {},
) {
  await page.goto("/");
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(files);
  if (options.expiry) await pickExpiry(page, options.expiry);
  if (options.downloads) {
    await pick(page, /\d+ downloads?$/, "How many downloads?", String(options.downloads));
  }
  if (options.password) await setPassword(page, options.password);
  await page.getByRole("button", { name: "Encrypt and upload" }).click();
  return shareLink(page);
}

export type NoteBlockInput =
  | { type: "Text"; text: string }
  | { type: "Password"; value: string }
  | { type: "Code"; code: string };

export async function shareNote(
  page: Page,
  blocks: NoteBlockInput[],
  options: { views?: "1"; password?: string; expiry?: string } = {},
) {
  await page.goto("/");
  await page.getByRole("tab", { name: /^Note/ }).click();
  for (const [index, block] of blocks.entries()) {
    // An empty note starts from a card per type, after that a row of buttons adds a block.
    if (index === 0) await page.getByRole("button", { name: new RegExp(`^${block.type}`) }).click();
    else await page.getByRole("button", { name: block.type, exact: true }).click();
    const editor = page.getByRole("region", { name: block.type }).last();
    if (block.type === "Text") await editor.getByRole("textbox", { name: "Text" }).fill(block.text);
    if (block.type === "Password")
      await editor.getByPlaceholder("Enter password...").fill(block.value);
    if (block.type === "Code")
      await editor.getByRole("textbox", { name: "Code", exact: true }).fill(block.code);
  }
  if (options.expiry) await pickExpiry(page, options.expiry);
  if (options.views) {
    await pick(
      page,
      /^(\d+|Unlimited) views?$|^Burn after reading$/,
      "How many views?",
      options.views,
    );
  }
  if (options.password) await setPassword(page, options.password);
  await page.getByRole("button", { name: "Encrypt and share" }).click();
  return shareLink(page);
}

/** Types the password of a share into its prompt and unlocks it. */
export async function unlock(page: Page, password: string) {
  await page.getByLabel("Enter password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Unlock" }).click();
}

/**
 * Collects the download tiers the app logs on a page. A tier that fails falls through to the
 * next, so a download that arrives proves nothing about the tier that was meant to carry it.
 */
export function watchTiers(page: Page) {
  const tiers: string[] = [];
  page.on("console", (message) => {
    const tier = /Download tier: (\d)/.exec(message.text());
    if (tier) tiers.push(tier[1]!);
  });
  return tiers;
}

/** Downloads the file of an open file link and returns what arrived. */
export async function downloadFile(page: Page) {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).click();
  const file = await download;
  const path = await file.path();
  await expect(page.getByText("Download complete!")).toBeVisible();
  return { name: file.suggestedFilename(), data: await readFile(path) };
}
