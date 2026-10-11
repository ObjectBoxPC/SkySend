import { expect, test } from "./support/fixtures.js";
import { confirm, randomFile, rowMenu } from "./support/flows.js";
import { createRequest, inboxRow, openInbox, sendToRequest } from "./support/requests.js";

test("a closed request takes no more uploads", async ({ page, openRecipient, guard }) => {
  const { uploadLink, inboxLink } = await createRequest(page);
  await guard.requestLinks(uploadLink, inboxLink);

  await openInbox(page, inboxLink);
  await page.getByRole("button", { name: "Close request" }).click();
  await confirm(page, "Close request");
  await expect(page.getByText("Request closed")).toBeVisible();

  const sender = await openRecipient();
  await sender.goto(uploadLink);
  await expect(sender.getByText("This request is closed")).toBeVisible();
  await expect(sender.getByRole("button", { name: "Encrypt and send" })).toHaveCount(0);
});

test("a full request takes no more uploads", async ({ page, openRecipient, guard }) => {
  const file = randomFile(20_000);
  guard.text(file.name);
  guard.content(file.name, file.buffer);
  const { uploadLink, inboxLink } = await createRequest(page, { uploads: 1 });
  await guard.requestLinks(uploadLink, inboxLink);

  await sendToRequest(await openRecipient(), uploadLink, { files: [file] });
  const late = await openRecipient();
  await late.goto(uploadLink);
  await expect(late.getByText("This request is full")).toBeVisible();
});

test("an inbox deletes one file, then the whole request", async ({
  page,
  openRecipient,
  guard,
}) => {
  const kept = randomFile(20_000);
  const dropped = randomFile(20_000);
  for (const file of [kept, dropped]) {
    guard.text(file.name);
    guard.content(file.name, file.buffer);
  }
  const { uploadLink, inboxLink } = await createRequest(page);
  await guard.requestLinks(uploadLink, inboxLink);
  // Two senders, so the inbox holds two uploads of their own.
  await sendToRequest(await openRecipient(), uploadLink, { files: [kept] });
  await sendToRequest(await openRecipient(), uploadLink, { files: [dropped] });

  await openInbox(page, inboxLink);
  await rowMenu(inboxRow(page, dropped.name), "Delete");
  await confirm(page, "Delete");
  await expect(page.getByText("File deleted")).toBeVisible();
  await expect(inboxRow(page, dropped.name)).toHaveCount(0);
  await expect(inboxRow(page, kept.name)).toBeVisible();

  await page.getByRole("button", { name: "Delete request" }).click();
  await confirm(page, "Delete");
  await expect(page.getByRole("heading", { name: "Request deleted" })).toBeVisible();
  const late = await openRecipient();
  await late.goto(uploadLink);
  await expect(late.getByText("This request does not exist")).toBeVisible();
});
