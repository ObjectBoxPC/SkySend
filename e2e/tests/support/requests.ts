import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page } from "@playwright/test";
import { pick, readLink, setPassword, unlock, type SharedFile } from "./flows.js";

export type RequestAsk = "Files" | "Note" | "Both";

/**
 * Creates a file request and returns its two links. A `field` lays out a note template with
 * one password field of that label, which the sender fills in.
 */
export async function createRequest(
  page: Page,
  options: {
    asks?: RequestAsk;
    title?: string;
    field?: string;
    password?: string;
    /** How long the request stays open, by the label of its option, like "5s". */
    expiry?: string;
  } = {},
) {
  await page.goto("/requests");
  if (options.asks && options.asks !== "Files") {
    await page.getByRole("tab", { name: new RegExp(`^${options.asks}`) }).click();
  }
  if (options.title) await page.getByLabel("What do you need? (optional)").fill(options.title);
  if (options.field) {
    await page.getByRole("button", { name: "Password", exact: true }).click();
    await page.getByPlaceholder("Field 1, for example Password").fill(options.field);
  }
  if (options.expiry) {
    await pick(page, /^Open for/, "How long is the request open?", options.expiry);
  }
  if (options.password) await setPassword(page, options.password);
  await page.getByRole("button", { name: "Create request" }).click();
  return {
    uploadLink: await readLink(page, "Upload link"),
    inboxLink: await readLink(page, "Your inbox link"),
  };
}

/**
 * Sends to a request from its upload link, the way a sender does: files, the fields of the
 * requester's template, or a text note written freely.
 */
export async function sendToRequest(
  page: Page,
  uploadLink: string,
  content: { files?: SharedFile[]; fields?: Record<string, string>; text?: string },
) {
  await page.goto(uploadLink);
  if (content.files) {
    await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(content.files);
  }
  for (const [label, value] of Object.entries(content.fields ?? {})) {
    await page.getByLabel(label, { exact: true }).fill(value);
  }
  if (content.text) {
    await page.getByRole("button", { name: /^Text/ }).click();
    await page.getByRole("textbox", { name: "Text", exact: true }).fill(content.text);
  }
  await page.getByRole("button", { name: "Encrypt and send" }).click();
  await expect(page.getByText("Delivered", { exact: true })).toBeVisible({ timeout: 30_000 });
}

/** Opens an inbox from its link, with the password of the request when it has one. */
export async function openInbox(page: Page, inboxLink: string, password?: string) {
  await page.goto(inboxLink);
  if (password) await unlock(page, password);
}

/**
 * The row of one upload in an inbox. Uploads sent together sit in a list of their own inside
 * the list, so the row is the innermost item that names it.
 */
export function inboxRow(page: Page, title: string) {
  return page
    .getByRole("listitem")
    .filter({ hasText: title })
    .filter({ hasNot: page.getByRole("listitem") });
}

/** Downloads the file of an inbox row and returns what arrived. */
export async function downloadFromInbox(row: Locator) {
  const download = row.page().waitForEvent("download");
  await row.getByRole("button", { name: "Download", exact: true }).click();
  const file = await download;
  const path = await file.path();
  return { name: file.suggestedFilename(), data: await readFile(path) };
}

/** Opens the note of an inbox row and returns its dialog. */
export async function openInboxNote(row: Locator) {
  await row.getByRole("button", { name: "Open", exact: true }).click();
  const dialog = row.page().getByRole("dialog", { name: "Note" });
  await expect(dialog).toBeVisible();
  return dialog;
}
