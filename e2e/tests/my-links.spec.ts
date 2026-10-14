import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.js";
import {
  confirm,
  randomFile,
  randomText,
  rowMenu,
  shareFiles,
  shareNote,
} from "./support/flows.js";
import { createRequest, inboxRow, sendToRequest } from "./support/requests.js";

// My Links lives in the IndexedDB of the browser that shared, so every step here runs in the
// sender's page, and only the recipient gets a browser of its own.

/** The row of a share or a request in My Links. */
function linkRow(page: Page, title: string) {
  return page.getByRole("listitem").filter({ hasText: title });
}

test("a file and a note stay in My Links until they are deleted there", async ({
  page,
  openRecipient,
  guard,
}) => {
  const file = randomFile(30_000);
  const text = randomText("Listed note");
  guard.text(file.name, text);
  guard.content(file.name, file.buffer);
  const fileLink = await shareFiles(page, [file]);
  const noteLink = await shareNote(page, [{ type: "Text", text }]);
  guard.secretOf(fileLink);
  guard.secretOf(noteLink);

  await page.goto("/uploads");
  const fileRow = linkRow(page, file.name);
  const noteRow = linkRow(page, "Text Note");
  await expect(fileRow).toBeVisible();
  await expect(noteRow).toBeVisible();

  // Deleting takes the owner token, which only this browser holds.
  await rowMenu(fileRow, "Delete");
  await confirm(page, "Delete");
  await expect(page.getByText("Upload deleted")).toBeVisible();
  await expect(fileRow).toHaveCount(0);
  await rowMenu(noteRow, "Delete");
  await confirm(page, "Delete");
  await expect(page.getByText("Note deleted")).toBeVisible();

  const recipient = await openRecipient();
  await recipient.goto(fileLink);
  await expect(recipient.getByText("Upload not found")).toBeVisible();
  await recipient.goto(noteLink);
  await expect(recipient.getByText("Note not found")).toBeVisible();
});

test("a request in My Links opens its inbox and is deleted there", async ({
  page,
  openRecipient,
  guard,
}) => {
  const title = randomText("Listed request");
  const file = randomFile(30_000);
  guard.text(title, file.name);
  guard.content(file.name, file.buffer);
  const { uploadLink, inboxLink } = await createRequest(page, { title });
  await guard.requestLinks(uploadLink, inboxLink);
  const sender = await openRecipient();
  await sendToRequest(sender, uploadLink, { files: [file] });

  await page.goto("/uploads?tab=requests");
  const row = linkRow(page, title);
  await expect(row).toContainText("1 upload received");
  await rowMenu(row, "Open inbox");
  await expect(inboxRow(page, file.name)).toBeVisible();

  await page.goto("/uploads?tab=requests");
  await rowMenu(linkRow(page, title), "Delete");
  await confirm(page, "Delete");
  await expect(page.getByText("Request deleted")).toBeVisible();
  const late = await openRecipient();
  await late.goto(uploadLink);
  await expect(late.getByText("This request does not exist")).toBeVisible();
});
