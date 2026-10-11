import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures.js";
import {
  downloadFile,
  randomFile,
  randomPassword,
  randomText,
  shareFiles,
  shareNote,
  unlock,
} from "./support/flows.js";
import { createRequest, openInbox, sendToRequest } from "./support/requests.js";

// The width of a small iPhone. Below 640 pixels the options of a share open in a sheet from the
// bottom instead of a popover at the pill, which is a path of its own.
test.use({ viewport: { width: 375, height: 812 }, hasTouch: true });

/** Fails when the page is wider than the screen, which lets a phone scroll it sideways. */
async function expectNoSidewaysScroll(page: Page, where: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${where} fits the screen`).toBeLessThanOrEqual(0);
}

test("a file is shared and opened on a phone", async ({ page, openRecipient, guard }) => {
  const file = randomFile(60_000);
  const password = randomPassword();
  guard.text(file.name, password);
  guard.content(file.name, file.buffer);

  // The download limit is picked in the sheet.
  const link = await shareFiles(page, [file], { downloads: 2, password });
  guard.secretOf(link);

  const recipient = await openRecipient();
  await recipient.goto(link);
  await unlock(recipient, password);
  const received = await downloadFile(recipient);
  expect(received.data.equals(file.buffer)).toBe(true);
});

test("a note to burn after reading is made on a phone", async ({ page, openRecipient, guard }) => {
  const text = randomText("Phone note");
  guard.text(text);
  const link = await shareNote(page, [{ type: "Text", text }], { views: "1" });
  guard.secretOf(link);

  const recipient = await openRecipient();
  await recipient.goto(link);
  await recipient.getByRole("button", { name: "View note" }).click();
  await expect(recipient.getByText(text)).toBeVisible();
  await expect(recipient.getByText("This note has been permanently deleted")).toBeVisible();
});

test("no page scrolls sideways on a phone", async ({ page, openRecipient, guard }) => {
  // One long word, the kind of name that pushes a layout wider than the screen.
  const file = {
    name: `quarterly-report-${randomBytes(24).toString("hex")}-final-version.pdf`,
    mimeType: "application/pdf",
    buffer: randomBytes(20_000),
  };
  const text = randomText("Wide note");
  guard.text(file.name, text);
  guard.content(file.name, file.buffer);

  for (const path of ["/", "/requests", "/uploads", "/settings", "/how"]) {
    await page.goto(path);
    await expect(page.getByRole("banner")).toBeVisible();
    await expectNoSidewaysScroll(page, path);
  }

  await page.goto("/");
  await page.locator('input[type="file"]:not([webkitdirectory])').setInputFiles(file);
  await expect(page.getByText(file.name)).toBeVisible();
  await expectNoSidewaysScroll(page, "the upload form with a long file name");

  const fileLink = await shareFiles(page, [file]);
  guard.secretOf(fileLink);
  await expectNoSidewaysScroll(page, "the finished share with its link");
  const noteLink = await shareNote(page, [{ type: "Text", text }]);
  guard.secretOf(noteLink);

  const { uploadLink, inboxLink } = await createRequest(page, {
    asks: "Both",
    field: "Wifi password",
  });
  await guard.requestLinks(uploadLink, inboxLink);
  await expectNoSidewaysScroll(page, "the links of a new request");
  await sendToRequest(await openRecipient(), uploadLink, {
    files: [file],
    fields: { "Wifi password": text },
  });

  const visitor = await openRecipient();
  await visitor.goto(fileLink);
  await expect(visitor.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await expectNoSidewaysScroll(visitor, "a file link");
  await visitor.goto(noteLink);
  await visitor.getByRole("button", { name: "View note" }).click();
  await expectNoSidewaysScroll(visitor, "an open note");
  await visitor.goto(uploadLink);
  await expect(visitor.getByRole("button", { name: "Encrypt and send" })).toBeVisible();
  await expectNoSidewaysScroll(visitor, "the upload page of a request");
  await openInbox(visitor, inboxLink);
  await expect(visitor.getByText(file.name)).toBeVisible();
  await expectNoSidewaysScroll(visitor, "an inbox with a long file name");
});
