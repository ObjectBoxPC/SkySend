import { expect, test } from "./support/fixtures.js";
import {
  randomFile,
  randomPassword,
  randomText,
  unlock,
  watchPresigned,
  watchTiers,
} from "./support/flows.js";
import {
  createRequest,
  downloadFromInbox,
  inboxRow,
  openInbox,
  openInboxNote,
  sendToRequest,
} from "./support/requests.js";

test("files sent to a request arrive in the inbox", async ({
  page,
  openRecipient,
  guard,
  expectedTier,
  storage,
}) => {
  const title = randomText("Tax documents");
  const file = randomFile(1024 * 1024 + 777);
  guard.text(title, file.name);
  guard.content(file.name, file.buffer);

  const { uploadLink, inboxLink } = await createRequest(page, { title });
  await guard.requestLinks(uploadLink, inboxLink);

  // The sender reads what was asked for, which only the link decrypts.
  const sender = await openRecipient();
  await sender.goto(uploadLink);
  await expect(sender.getByText(title)).toBeVisible();
  await sendToRequest(sender, uploadLink, { files: [file] });

  // The requester opens the inbox on another device, with nothing but the inbox link.
  const inbox = await openRecipient();
  const tiers = watchTiers(inbox);
  const presigned = watchPresigned(inbox);
  await openInbox(inbox, inboxLink);
  await expect(inbox.getByText(title)).toBeVisible();
  const received = await downloadFromInbox(inboxRow(inbox, file.name));

  expect(received.name).toBe(file.name);
  expect(received.data.equals(file.buffer)).toBe(true);
  expect(tiers).toEqual([expectedTier]);
  if (storage === "s3") expect(presigned.length, "a download from the bucket").toBeGreaterThan(0);
  else expect(presigned).toEqual([]);
});

test("files and a note arrive together as one submission", async ({
  page,
  openRecipient,
  guard,
  expectedTier,
}) => {
  const field = randomText("Database password");
  const value = randomPassword();
  const file = randomFile(200_000);
  guard.text(field, value, file.name);
  guard.content(file.name, file.buffer);

  const { uploadLink, inboxLink } = await createRequest(page, { asks: "Both", field });
  await guard.requestLinks(uploadLink, inboxLink);

  const sender = await openRecipient();
  await sendToRequest(sender, uploadLink, { files: [file], fields: { [field]: value } });

  const inbox = await openRecipient();
  const tiers = watchTiers(inbox);
  await openInbox(inbox, inboxLink);
  const submission = inbox.getByRole("list", { name: "Sent together" });
  await expect(submission.getByRole("listitem")).toHaveCount(2);

  const received = await downloadFromInbox(inboxRow(inbox, file.name));
  expect(received.data.equals(file.buffer)).toBe(true);
  expect(tiers).toEqual([expectedTier]);

  const note = await openInboxNote(inboxRow(inbox, "Note"));
  await expect(note.getByText(field)).toBeVisible();
  await expect(note.getByText(value)).toHaveCount(0);
  await note.getByRole("button", { name: "Reveal" }).click();
  await expect(note.getByText(value)).toBeVisible();
});

test("a password protects an inbox", async ({ page, openRecipient, guard }) => {
  const password = randomPassword();
  const text = randomText("Access for the new laptop");
  guard.text(password, text);

  const { uploadLink, inboxLink } = await createRequest(page, { asks: "Note", password });
  await guard.requestLinks(uploadLink, inboxLink);

  const sender = await openRecipient();
  await sendToRequest(sender, uploadLink, { text });

  const inbox = await openRecipient();
  await inbox.goto(inboxLink);
  await expect(inbox.getByText("This inbox is password protected")).toBeVisible();
  await unlock(inbox, `${password}-wrong`);
  await expect(inbox.getByText("Incorrect password")).toBeVisible();
  await expect(inbox.getByText(text)).toHaveCount(0);

  await unlock(inbox, password);
  const note = await openInboxNote(inboxRow(inbox, "Note"));
  await expect(note.getByText(text)).toBeVisible();
});
